/**
 * Tools for sharing tasks, values, services, etc., especially across job
 * boundaries.
 *
 * @module uneventful/shared
 * @disableGroups
 */

import { currentCell } from "./ambient.ts"
import { getCell } from "./cells.ts"
import { Deps, getHooks, getMemo, setMemo, staleDeps } from "./hooks.ts"
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

/**
 * Wrap a generator, generator function, or generator method to run in parallel
 * and have a result that can be waited on in parallel as well.
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
export function fork<T>(gen: Yielding<T>): Yielding<T>
export function fork<T, F extends (...args: any[]) => Yielding<T>>(genFunc: F): F
/** @hidden TC39 decorator */
export function fork<T, F extends (...args: any[]) => Yielding<T>>(genFunc: F, ctx: {kind: "method"}): F
/** @hidden legacy decorator */
export function fork<T, F extends (...args: any[]) => Yielding<T>, D extends {value?: F}>(clsOrProto:any, name: string|symbol, desc: D): D

// Implementation
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
 * @summary Return a singleton instance for the given factory, or create a
 * per-signal call-site cache (a bit like React's `useMemo()`).
 *
 * @category Singletons & Caching
 */
export function $<T>(factory: Factory<T>): T

/**
 * Create a per-signal call-site cache (ala React `useMemo`), via
 * ```$``()```
 *
 * When you call ```$``(factory, deps)``` inside a given signal function for the
 * first time, `factory()` will be called and returned, and the result cached
 * for future calls *at the same location in that specific signal*.  If the
 * values provided in the optional `deps` array differ from one call to the
 * next, the cached value is discarded and recomputed. An error results if
 * called outside a signal function.
 *
 * If you're familiar with React, you can think of this as being like calling
 * `useMemo()`, with less of an ordering constraint.  (Which is why it's not
 * *called* useMemo, as some aggressive linters may complain about it not being
 * used in a React component.)
 *
 * While React hooks must all be called in the same order on every component
 * refresh, ```$``()``` calls can be skipped or called in a different order, as
 * they are identified by *code location* rather than by invocation order.  (You
 * can even use them inside of loops, they'll just always return the same result
 * for every iteration!)
 *
 * (Also unlike React hooks, they can also be used in nested functions, as long
 * as those functions are only called from within the relevant signal.)
 *
 * @category Singletons & Caching
 */
export function $(template: TemplateStringsArray): <T>(factory: () => T, deps?: Deps) => T

export function $<T>(key: Factory<T> | TemplateStringsArray): T | ((factory: () => T, deps?: Deps) => T) {
    var factory: Factory<T>
    if (isFunction(key)) {
        // It's a factory, create (or return) an instance
        return constants.has(key) ? constants.get(key) : setMap(constants, key,
            (isClass(factory = factories.has(key) ? factories.get(key) : key) ? new factory : factory())
        )
    }
    // It's a template, return a function
    return ((factory: () => T, deps?: Deps) => {
        const hooks = getHooks(currentCell || getCell("$``() "))
        return staleDeps(hooks, key, deps, 2) ? setMemo(hooks, 2, factory()) : getMemo(hooks, 2)
    })
}

/**
 * Utilities for manipulating the singleton cache (e.g. for testing)
 *
 * @category Singletons & Caching
 * @namespace
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
