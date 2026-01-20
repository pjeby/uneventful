/**
 * Tools for sharing tasks, values, services, etc., especially across job
 * boundaries.
 *
 * @module uneventful/shared
 * @disableGroups
 */

import { CallSite, perSignal } from "./hooks.ts"
import { must, start } from "./jobutils.ts"
import { noop } from "./results.ts"
import { root, newRoot } from "./tracking.ts"
import { JobIterator, Yielding } from "./types.ts"
import { apply, decorateMethod, isClass, isFunction, isGeneratorFunction, setMap } from "./utils.ts"

/**
 * Wrap a factory function to create a singleton service accessor
 *
 * The returned function, when called, will run the factory in a new job and
 * cache the result.  The job the factory ran in will end when the {@link root}
 * job does, after which the cached result will be cleared.
 *
 * @param factory A function returning whatever result you want to share: a
 * value, a function, an object, etc.  It will be called at most once per root
 * job lifetime, in a job that is an immediate child of the root job.
 *
 * (Note: if your factory is a native generator function, it is automatically
 * wrapped with {@link fork}() so that its job will not end when the generator
 * ends, and the result can be waited on by multiple callers.  If your factory
 * is *not* a native generator function but still returns a generator to produce
 * an async result, you should wrap that generator with {@link fork} before
 * returning it.)
 *
 * @remarks Note that if you want your code to be testable with {@link newRoot},
 * you should avoid storing the *result* of calling the service accessor
 * anywhere it can outlive the root job, since you will otherwise end up with a
 * stale reference to the previous service instance *and* fail to initialize the
 * new instance.
 *
 * Your services can detect this scenario, however, by having the factory wrap
 * its return value with {@link expiring}(), which will make any access to a
 * saved service value throw a TypeError after the root job ends.  (Note that
 * such a thing should not be necessary in your production builds, however,
 * since at runtime you will normally only ever have one root job.)
 *
 * @category Resources
 */
export function service<T>(factory: () => T): () => T {
    let known = false, value: T = undefined;
    if (isGeneratorFunction<JobIterator<any>>(factory)) factory = fork(factory)
    return () => {
        if (known) return value
        root.start(() => {
            value = factory()
            known = true
            must(() => { value = undefined; known = false; })
        })
        return value
    }
}

/**
 * Proxy an object so it "expires" (becomes inaccessible) with the calling job.
 *
 * Any attempts to use the returned object after the job ends or restarts (other
 * than to check its `typeof`) will result in a TypeError.
 *
 * Note: your runtime environment must support `Proxy.revocable()`.
 *
 * @category Resources
 */
export function expiring<T extends object>(obj: T): T {
    const p = Proxy.revocable(obj, {})
    must(p.revoke)
    return p.proxy
}

export function fork<T>(gen: Yielding<T>): Yielding<T>
export function fork<T, F extends (...args: any[]) => Yielding<T>>(genFunc: F): F
/** @hidden TC39 decorator */
export function fork<T, F extends (...args: any[]) => Yielding<T>>(genFunc: F, ctx: {kind: "method"}): F
/** @hidden legacy decorator */
export function fork<T, F extends (...args: any[]) => Yielding<T>, D extends {value?: F}>(clsOrProto:any, name: string|symbol, desc: D): D
// Implementation
/**
 * Wrap a generator, generator function, or generator method to run in parallel
 * and have a result that can be waited on in parallel as well.
 *
 * | Expression          | Returns | Behavior |
 * | ------------------- | ------- | -------- |
 * | `fork(Yielding<T>)`   | {@link Yielding `Yielding<T>`} | [Fork a generator](#fork) |
 * | `fork(function *(...): Yielding<T>)` | `(...) => Yielding<T>` | [Wrap a generator function to fork on call](#fork-1) |
 * | `@fork *method(): Yielding<T>`   | `Yielding<T>`          | Decorate[^1] a method to fork on call |
 *
 * [^1]: Both TC39 decorators and "legacy" TypeScript/Babel decorators are
 * supported.
 *
 * Normally, when you `yield *` to a generator in a job function, you're
 * *pausing* the current function until that generator is finished.  And
 * normally, this is what you *want*, because you're not trying to do things in
 * parallel.  But if you *do* want to do things in parallel, you need `fork`.
 *
 * Generators also can't normally be *waited on* in parallel either: if multiple
 * jobs try to wait on an unfinished generator, the most likely result is an
 * error or data corruption. (Because the extra `yield *` operations will make
 * the generator think it's received data it was waiting for, causing all kinds
 * of havoc.)
 *
 * So if you want a generator to either *run* in parallel or be *waited on* in
 * parallel (or both), you need to `fork` it: either on the consuming side by
 * wrapping a generator with `fork()`, or on the producing side by wrapping a
 * generator function (or decorating a generator method).
 *
 * When called with a generator, `fork` returns a wrapped generator; when called
 * with a function, it returns a wrapped version of the function that will fork
 * its results.  And when used as a decorator (`@fork`, compatible with both
 * TC39 and legacy decorator protocols), it wraps a method to fork its result as
 * well.
 *
 * It is safe to call `fork()` more than once on the same generator, or to
 * `fork()` an already-forked generator: the result will always be the same as
 * the original fork.
 *
 * @remarks Note that while you can *also* make a generator run or be waitable
 * in parallel using e.g. `start()`, the critical difference is in when resource
 * cleanup happens. If you `start()` the generator (or wrap the generator
 * function with `task`), its resources will be cleaned up when the generator
 * function exits.
 *
 * With `yield*`, however (with or without `fork`), the resources are cleaned up
 * when the original *calling* job ends.  And this is what you want when the
 * generator's return value is some kind of resource using other active
 * resources (such as event listeners rules, etc.) that need to *remain* active
 * for the caller.
 *
 * (If you're familiar with the Effection framework, you may recognize this as
 * the difference between "actions" and "resources": in Uneventful we use
 * `start()` or `task()` for generators that return the result of an action, and
 * `fork` for generators that return a resource that will be owned by the
 * calling job.)
 *
 * @category Resources
 */
export function fork<T, F extends (...args: any[]) => Yielding<T>>(
    genOrFunc:Yielding<T> | ((...args: any[]) => Yielding<T>), ...args: any[]
) {
    if (args.length) return decorateMethod(fork, genOrFunc, ...args as [any, any]);
    if (isFunction(genOrFunc)) return (function(this: any, ...args: Parameters<F>) {
        return fork(apply(genOrFunc, this, args))
    }) as F; else {
        if (forks.has(genOrFunc)) return forks.get(genOrFunc);
        const job = start<T>();
        start(function *run(){
            try { job.return(yield *genOrFunc); }
            catch(e) { job.throw(e); }
            yield noop;  // suspend until canceled
        })
        const it = { [Symbol.iterator]: job[Symbol.iterator].bind(job) }
        return setMap(forks, it, setMap(forks, genOrFunc, it))
    }
}

const forks = new WeakMap<Yielding<any>, Yielding<any>>()


/** @inline */
type Factory<T> = (() => T) | (new () => T)
const constants = new WeakMap(), factories = new WeakMap<Factory<any>, Factory<any>>()

/**
 * Return a singleton instance for the given factory
 *
 * Every call to `$()` with a given factory will return the same result. (Unless
 * overridden using {@link $cache.set}, {@link $cache.unset} or
 * {@link $cache.replace}.)  On first use, the factory is called (or
 * constructed, if it's a class) and the result (if not an error) is cached for
 * future calls.
 *
 */
export function $<T>(factory: Factory<T>): T

/**
 * Create a per-signal lazy constant, via ```$``()```
 *
 * When you call ```$``(factory)``` inside a given signal function for the first
 * time, `factory()` will be called (or constructed, if it's a class) and
 * returned, and the result cached for future calls *at the same location in
 * that specific signal*.  An error results if called outside a signal function.
 *
 * The primary difference between this and the singleton operator (plain `$()`),
 * is that lazy constants are singletons *per call-site*, *per signal*.  A
 * specific invocation of ```$``()``` in a specific signal will always return
 * the same value.
 *
 * @remarks
 * Lazy constants are somewhat similar in concept to a React `useMemo()`, but
 * also *very* different. React requires hooks to always be invoked in the same
 * order to match them up with their targets, but lazy constants do not need
 * this: they're tied to the line of code where they're called, and you can
 * branch, loop, skip, or call them out of order with no consequence.  (They'll
 * just always return the same value each time if running in the same signal -
 * even in a loop or called in another function with different arguments, and
 * they don't support dependencies because you can use signals instead.)
 *
 * (Also unlike React hooks, they can also be used in nested functions, as long
 * as those functions are only invoked from within a relevant signal.
 * Conversely, because they're keyed to a specific code location, you can't just
 * call a wrapping function more than once in a signal, and expect to get
 * different results: a lazy constant is a per-signal *constant*, not a React
 * hook!)
 */
export function $(callSite: CallSite): <T>(factory: Factory<T>) => T

/**
 * Return a singleton instance for the given factory, or create a per-signal
 * lazy constant (a bit like React's `useMemo`, but without the deps or ordering
 * constraints).
 *
 * | Expression                    | Returns | Behavior |
 * | ----------------------------- | ------- | -------- |
 * | `$(() => T \| new () => T)`   | `T`     | [Get or make a singleton instance](#-)     |
 * | ```$``(() => T \| new () => T)``` | `T` | [Return a per-signal lazy constant](#--1) |
 *
 * #### Lazy-Initialized Singletons
 * In complex programs and frameworks, it's often beneficial to both 1) have a
 * single access point for some functionality, and 2) not to need a specific
 * point where that access is explicitly initialized.  [The `$()` function](#-)
 * lets you unobtrusively request a singleton instance to be instantiated on
 * demand, then shared with all other access points in the program, and it does
 * so without requiring any change to the target class or classes.  (You can
 * even {@link $cache.set override the target instance} or
 * {@link $cache.replace replace its factory}, as one might with a
 * dependency-injection container.)
 *
 * #### Lazy Constants in Signal Functions
 * Within functions, there's often a need to have some state that carries across
 * multiple calls to the function.  (Like what other languages do with
 * function-static variables.)
 *
 * You can do something like this with a closure, of course, but it often
 * increases code complexity, especially when writing signal functions. So [the
 * lazy-constant operator (```$``()```) ](#--1) lets you write expressions like
 * ```const myMap = $``(WeakMap<...>)``` instead of needing to initialize (or at
 * least define) `myMap` outside the signal function body.
 *
 * @category Singletons & Lazy Constants
 * @experimental
 */
export function $<T>(key: Factory<T> | CallSite): T | ((factory: Factory<T>) => T) {
    if (isFunction(key)) {
        // It's a factory, create (or return) an instance
        return constants.has(key) ? constants.get(key) : setMap(constants, key,
            callOrConstruct(factories.has(key) ? factories.get(key) : key)
        )
    }
    // It's a call site for ``, return a function
    return perSignal<(factory: Factory<T>) => T>(callOrConstruct, key, "$``() ")
}

/** Call or construct a zero-arg factory */
function callOrConstruct<T>(f: Factory<T>): T { return isClass(f) ? new f : f() }

/**
 * Utilities for manipulating the singleton cache (e.g. for testing)
 *
 * @category Singletons & Lazy Constants
 * @namespace
 * @experimental
 */
export const $cache = {
    /**
     * Set the cached singleton instance for a given factory.  (e.g. for
     * testing)
     *
     * All subsequent calls to `$(factory)` will return the given result, until
     * manually set again, or reset via {@link $cache.unset}.
     */
    set<T>(factory: Factory<T>, result: T) {
        constants.set(factory, result)
    },

    /**
     * Unset the cached singleton for a given factory, such that the next call
     * to `$(factory)` will create a new instance.
     */
    unset<T>(factory: Factory<T>) {
        constants.delete(factory)
    },

    /**
     * Replace the implementation for a given factory, such that future calls to
     * `$(factory)` will call or construct the replacement instead.
     *
     * If the replacement is omitted, null, or undefined, future calls will
     * invoke the original factory again.
     *
     * (Note: in all cases the replacement will not take effect if there's
     * already a cached singleton, so you may wish to call
     * {@link $cache.unset}() to ensure a future call is actually executed.)
     */
    replace<T>(factory: Factory<T>, replacement?: Factory<T>) {
        (replacement != null && replacement !== factory) ? factories.set(factory, replacement) : factories.delete(factory)
    }
}
