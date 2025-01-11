/**
 * Tools for sharing tasks, values, services, etc., especially across job
 * boundaries.
 *
 * @module uneventful/shared
 */

import { must, start } from "./jobutils.ts";
import { noop } from "./results.ts";
import { root, newRoot } from "./tracking.ts";
import { JobIterator, Yielding } from "./types.ts";
import { apply, decorateMethod, isFunction, isGeneratorFunction, setMap } from "./utils.ts";

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
