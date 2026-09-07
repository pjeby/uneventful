/**
 * Tools for sharing tasks, values, services, etc., especially across job
 * boundaries, but also across reactive expression lifetimes (similar to React
 * hooks).
 *
 * @module uneventful/shared
 * @disableGroups
 */

import { popCtx, pushCtx } from "./ambient.ts"
import { CallSite, perSignal } from "./hooks.ts"
import { lazyConstants, Factory, rootId } from "./internals.ts"
import { must, start } from "./jobutils.ts"
import { noop } from "./results.ts"
import { root, newRoot } from "./tracking.ts"
import { Job, JobIterator, Yielding } from "./types.ts"
import { apply, decorateMethod, isClass, isFunction, isGeneratorFunction, setMap } from "./utils.ts"

/**
 * Define a configurable service accessor
 *
 * The returned accessor function, when called, will run the factory in the
 * {@link root} job and cache the result until/unless a new root is started.
 *
 * The factory and result can be overridden at runtime using the accessor's
 * methods: i.e. `myService.set(obj)` sets the instance that `myService()` will
 * return, `myService.replace(otherFactory)` changes the factory used to create
 * it, and so on.
 *
 * @param defaultFactory The {@link ServiceFactory} function or class whose
 * shared/cached result the accessor returns by default.  See
 * {@link ServiceFactory} for important details on how the factory is run and
 * the restrictions on what it can do.
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
export function service<T>(defaultFactory: ServiceFactory<T>): ServiceAccessor<T> {
    let validFor = -1
    let value = noop as unknown as T // prebuild shape for object/function pointer
    let currentFactory = defaultFactory
    function get(): T {
        return validFor === rootId ? value : (
            value = createSingleton(get, currentFactory, root), validFor = rootId, value
        )
    }
    return Object.assign(get, {
        set(result: T) {
            validFor = rootId; value = result
        },
        unset() {
            validFor = -1; value = undefined as unknown as T
        },
        replace(replacement: ServiceFactory<T> = defaultFactory) {
            currentFactory = (replacement != null && replacement !== get) ? replacement : defaultFactory
        }
    })
}

/**
 * A configurable access point for a lazily-created {@link service}.
 *
 * @category Types and Interfaces
 */
export interface ServiceAccessor<T> {
    /** Return the service's current instance, creating it if necessary */
    (): T
    set(instance: T): void
    unset(): void
    replace(factory?: ServiceFactory<T>): void
}

/**
 * A function, or class constructor producing a value that will be cached by a
 * `service()` accessor for the life of the root job.  (Or until overridden via
 * a service accessor's set/unset methods.)
 *
 * The function or constructor will be run in the then-current root job, and its
 * value cached.  If the function is a native generator function, it is
 * automatically wrapped with {@link fork}(), so that its job will not end when
 * the generator ends, and the result can be waited on by multiple callers.  (If
 * your factory is *not* a native generator function but still returns a
 * generator to produce an async result, you should wrap that generator with
 * {@link fork} before returning it.)
 *
 * Note: if an original or replacement factory directly or indirectly requests
 * its own value (even via a {@link service}() accessor), an error is thrown to
 * prevent infinite recursion.  An error is also thrown if a reactive value is
 * directly or indirectly accessed during the factory's execution, to prevent
 * your cached service from unintentionally retaining a stale value.  (Rules
 * and {@link uneventful/signals.fx fx()} are unaffected, as they will update
 * their state as needed.)
 *
 * @category Types and Interfaces
 */
export type ServiceFactory<T> = (() => T) | (new () => T)

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



/**
 * A function, or class constructor producing a value that will be cached by
 * ```$``()``` as a permanent-per-signal constant at a given call site.
 *
 * The function or constructor will be run *without* an active job, and its
 * value cached.  While it runs, any attempt to directly access a reactive value
 * or expression will be blocked by a thrown error, to prevent your cached
 * result from capturing a stale value.
 *
 * Note that unlike {@link ServiceFactory}, a ConstantFactory *cannot* use job
 * APIs, rules, or fx(), nor is there any special handling for generator
 * functions.  None of these things make any sense for a lazy constant, as there
 * is no way to clean up after them: they simply exist for the life of the
 * signal (or root job, for global constants) and so should be relatively
 * stateless.
 *
 * @category Types and Interfaces
 */
export type ConstantFactory<T> = (() => T) | (new () => T)

/**
 * Return a lazily-initialized constant value for the given factory
 *
 * Every call to `$()` with a given factory will return the same result.
 * (Until/unless a new root job is started.)
 *
 * On first use, the factory is called (or constructed, if it's a class) and the
 * result (if not an error) is cached for future calls.
 *
 * @param factory The {@link ConstantFactory} function or class whose
 * shared/cached value you want to get.  (See {@link ConstantFactory} for
 * important details on how the factory is run and the restrictions on what it
 * can do.)
 */
export function $<T>(factory: ConstantFactory<T>): T

/**
 * Create a per-signal lazy constant, via ```$``()```
 *
 * When you call ```$``(factory)``` inside a given signal function for the first
 * time, the {@link ConstantFactory} will be called (or constructed, if it's a
 * class) and the returned result will be cached for ALL future calls *at the
 * same code location in that specific signal*.  An error results if called
 * outside a signal function.  See the {@link ConstantFactory} docs for more
 * details on how the factory is called, and the restrictions on what it can do.
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
 *
 * @experimental
 */
export function $(callSite: CallSite): <T>(factory: ConstantFactory<T>) => T

/**
 * Return a lazy constant for the given factory, either globally or per-signal.
 *
 * | Expression         | Behavior |
 * | ------------------ | -------- |
 * | `$(factory)`       | [Return a global lazy constant](#_)    |
 * | ```$``(factory)``` | [Return a per-signal lazy constant](#_-1) |
 *
 * #### Lazy-Initialized Constants
 * In complex programs and frameworks, it's often beneficial to have a constant
 * value that's lazily initialized.  [The `$()` function](#_) lets you
 * unobtrusively request a constant to be instantiated on demand, then shared
 * with all other access points in the program, without requiring any change to
 * the initializer class or function.  (Note: if you want to have a
 * *configurable* service that can be overridden for testing or selectable
 * implementations, use {@link service}() instead.)
 *
 * #### Per-callsite Lazy Constants in Signal Functions
 * Within signal functions, there's often a need to have some state that carries
 * across multiple calls to the function.  (Like what other languages do with
 * function-static variables, or React does with `useMemo()`.)
 *
 * You can do something like this with a closure, of course, but it often
 * increases code complexity, especially when writing signal functions. So [the
 * per-signal lazy-constant operator (```$``()```) ](#_-1) lets you write
 * expressions like ```const myMap = $``(WeakMap<...>)``` instead of needing to
 * initialize (or at least define) `myMap` outside the signal function body.
 *
 * @category Lazy Constants
 */
export function $<T>(key: ConstantFactory<T> | CallSite): T | ((factory: ConstantFactory<T>) => T) {
    if (isFunction(key)) {
        // It's a factory, create (or return) an instance
        return lazyConstants.has(key) ? lazyConstants.get(key) as T : setMap(
            lazyConstants, key, createSingleton(key)
        ) as T
    }
    // It's a call site for ``, return a function
    return perSignal<(factory: ConstantFactory<T>) => T>(callOrConstruct, key, "$``() ")
}

const stack: ServiceFactory<unknown>[] = []

/**
 * Prevent cyclical, job, and reactive dependencies while constructing, and run
 * factories in the root or empty job.
 */
function createSingleton<T>(key: Factory<T>, f = key, runIn?: Job): T {
    if (stack.indexOf(key) > -1) throw new Error("Factory depends on itself")
    if (runIn && isGeneratorFunction<JobIterator<unknown>>(f)) f = fork(f)
    stack.unshift(key)
    pushCtx(runIn, false) // block reactive reads & run in root
    try { return callOrConstruct(f) } finally { stack.shift(); popCtx() }
}

/** Call or construct a zero-arg factory */
function callOrConstruct<T>(f: Factory<T>): T { return isClass(f) ? new f : f() }
