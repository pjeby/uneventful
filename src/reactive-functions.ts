import { currentCell, currentJob } from "./ambient.ts"
import { Job } from "./types.ts"
import { Cell, defaultQ } from "./cells.ts"
import { decorateMethod, isFunction, isPlainFunction, setMap } from "./utils.ts"
import { must } from "./jobutils.ts"
import { SetOrSingle, sosAdd, sosDel, sosHas, sosSize } from "./sos.ts"
import { getJob } from "./tracking.ts"
import { perSignal } from "./hooks.ts"
import { Signal, cached } from "./signals.ts"

/** @inline */
type Get<V> = () => V;

/** @inline */
type GetFactory<O extends WeakKey, V=void> = (obj: O) => Get<V>;

/** @inline */
type Method<O extends WeakKey, V=void> = (this: O) => V;

/** @inline */
type DeferredFn = {
    <Result>(compute: () => Result): Signal<Result>
    <Instance extends WeakKey, Result>(factory: GetFactory<Instance, Result>): (obj: Instance) => Result
}

/** @inline */
type DeferredFx = {
    (compute: () => void): Get<void>
    <Instance extends WeakKey>(factory: GetFactory<Instance, void>): (obj: Instance) => void
}


/**
 * Create a signal that computes a value based on other signals.  (Can also be
 * used as a method decorator via `@fn`, with either TC39 or "Legacy"
 * decorators.)
 *
 * @param compute The function that will be called to compute the result, if the
 * signals it used in its last invocation have changed since then.
 *
 * @returns A signal that returns a cached value or recomputes it as necessary,
 * and will be tracked as a dependency for other signals, rules, or effects,
 * when they use it in their calculations.
 *
 * @template Result The type of value the created signal will provide.
 *
 * @category none
 */
export function fn<Result>(compute: Get<Result>): Signal<Result>;

/**
 * Create a parameterized reactive function that tracks separate dependencies
 * and caching state for each object it's called on.
 *
 * @returns a one-argument reactive function that is shorthand for looking up
 * and returning the value of a cached signal customized for the given argument.
 *
 * That is, given `rf = fn(a => () => a.bar)`, calling `rf(foo)` is equivalent
 * to calling `fn(() => foo.bar)()`, except that each `foo` gets its own `fn(()
 * => foo.bar)` signal cached, so that dependencies can be properly tracked
 * per instance.
 *
 * @param factory A function that will be called with each new instance passed
 * to the one-argument reactive function.  It must return a zero-argument
 * function, customized to compute the value for the instance it was given.
 *
 * @template Instance The type of object the created function will be used with
 * @template Result The type of result the created function will return
 *
 */
export function fn<Instance extends WeakKey, Result>(factory: GetFactory<Instance, Result>): (obj: Instance) => Result;

/** @hidden support for ```fn``()``` */
export function fn(t: TemplateStringsArray): DeferredFn

/** @hidden TC39 decorator */
export function fn<Instance extends WeakKey, Result>(
    f: Method<Instance, Result>, ctx: {kind: "method"}
): Method<Instance, Result>

/** @hidden "Legacy"/"TypeScript Experimental" Decorator */
export function fn<Instance extends WeakKey, Result, D extends {value?: Method<Instance, Result>}>(
    clsOrProto: any, name: string|symbol, desc: D
): D

/**
 * Create a computed signal from a function, method, or function-returning
 * function
 *
 * | Expression          | Returns | Behavior |
 * | ------------------- | ------- | -------- |
 * | `fn(() => T)`       | {@link Signal `Signal<T>`} | [Create a computed signal](#fn) |
 * | ```fn``(() => T)``` | `Signal<T>`  | Same, but with call site caching[^inline] |
 * | `fn(ob => () => T)` | `ob => T`    | [Create a function that gets the result of a per-object computed signal](#fn-1) |
 * | ```fn``(ob => () => T)``` | `ob => T`    | Same, but with call site caching<sup>[[1]](#fninline)</sup> |
 * | `@fn method(): T`   | `T`          | Decorate[^dec] a method to act as a computed signal |
 *
 * [^inline]: ```fn``(...)``` is shorthand for ```$``(() => fn(...))``` [^lazy].
 * That is, it acts just like any other call to `fn`, except that it only runs
 * at most once *per code location* in a given signal function.  The result is
 * then cached and returned for every subsequent call from that specific
 * location in the same signal function.
 *
 * [^lazy]: ```$``()``` is
 *     {@link uneventful/shared.$ the lazy constant operator}.  It allows for an
 *     expression to only be evaluated once during the life of an enclosing
 *     signal, by caching the result on its first invocation.
 *
 * [^dec]: Both TC39 decorators and "legacy" TypeScript/Babel decorators are
 *     supported.
 */
export function fn<O extends WeakKey, V>(
    f: GetFactory<O,V> | Get<V> | Method<O,V> | TemplateStringsArray, ...args: any[]
): Signal<V> | ((ob: O) => V) | DeferredFn {
    if (args.length) {
        // @fn
        return decorateMethod(f => {
            const map = new WeakMap<O, Cell>();
            return function(this: O) {
                return (
                    map.get(this) || setMap(map, this, Cell.mkCached(f.bind(this)))
                ).getValue()
            }
        }, f as Method<O,V>, ...args as [any, any]);
    } else if (!isFunction(f)) {
        // fn``()
        return perSignal(fn, f, "fn``() ")
    } else if (f.length) {
        // fn(ob => () => T)
        const map = new WeakMap<O, Cell>();
        return (ob: O) => (map.get(ob) || setMap(map, ob, Cell.mkCached((f as GetFactory<O,V>)(ob)))).getValue()
    }
    // fn(() => T)
    return cached(f as Get<V>)
}


/**
 * Create a reactive effect (void signal) that runs when observed by a rule
 * (directly or via other reactive functions).  (Can also be used as a method
 * decorator via `@fx`, with either TC39 or "Legacy" decorators.)
 *
 * @remarks Note that reactive effects do not actually execute unless they are
 * "in use", i.e. either directly invoked from an active job or called
 * indirectly from a rule or effect that is itself in use.
 *
 * @param effect The function that will be called to start (or restart) the
 * effect, if the reactive values it used during its last run have changed since
 * then.
 *
 * The effect function is run in a job that will restart if its dependencies
 * change, and when the effect is no longer in use.  (So you can use e.g.
 * {@link must}() to define rollback actions, and any jobs, subscriptions, etc.
 * you start inside the effect function will likewise be terminated when the
 * effect becomes unobserved or its dependencies change.)
 *
 * @returns a zero-argument reactive function that can be called from any rule,
 * job, or other observed reactive functions, to start or continue the effect.
 *
 * Multiple calls from the same or different observers do not restart the
 * effect; only dependency changes will restart it.  If it loses all observers
 * (i.e. fails to be called by any of them, or all the calling jobs end), the
 * effect will stop until it's in use again.
 *
 * @category none
 */
export function fx(effect: Get<void>): Get<void>;

/**
 * Create a parameterized reactive effect that tracks separate dependencies,
 * jobs, and caching state for each object it's called on.
 *
 * @returns a one-argument reactive effect that is shorthand for looking up and
 * calling a cached, zero-argument reactive effect customized for the given
 * argument.
 *
 * That is, given `rx = fx(a => () => a.bar())`, calling `rx(foo)` is equivalent
 * to calling `fx(() => foo.bar())()`, except that each `foo` gets its own
 * `fx(() => foo.bar())` instance cached, so that dependencies can be properly
 * tracked per instance.
 *
 * @param factory A function that will be called with each new instance passed
 * to the returned effect function.  It must return a zero-argument effect
 * function, customized to apply the effect to the instance it was given.
 *
 * @template Instance The type of object the effect will be applied to
 *
 */
export function fx<Instance extends WeakKey>(factory: GetFactory<Instance>): (ob: Instance) => void;

/** @hidden support for ```fx``()``` */
export function fx(t: TemplateStringsArray): DeferredFx

/** @hidden TC39 decorator */
export function fx<Instance extends WeakKey>(method: Method<Instance>, ctx: {kind: "method"}): Method<Instance>

/** @hidden "Legacy"/"TypeScript Experimental" Decorator */
export function fx<Instance extends WeakKey, D extends {value?: Method<Instance>}>(
    clsOrProto:any, name: string|symbol, desc: D
): D

/**
 * Create or invoke a reactive effect.
 *
 * | Expression           | Returns      | Behavior |
 * | -------------------- | ------------ | -------- |
 * | `fx(() => {})`       | `() => void` | [Create a reactive effect](#fx) |
 * | ```fx``(() => {})``` | `() => void` | Same, but with call site caching[^inline] |
 * | `fx(ob => () => {})` | `ob => void` | [Create a function that applies a per-object reactive effect](#fx-1) |
 * | ```fx``(ob => () => {})``` | `ob => void` | Same, but with call site caching<sup>[[1]](#fninline)</sup> |
 * | `@fx method(): void` | `void`       | Decorate[^dec] a method to act as a per-object reactive effect |
 *
 * Reactive effects are functions that re-run whenever there are changes to the
 * values of the signals they used during their last run.
 *
 * Each effect runs in its own job that is restarted when the effect is re-run
 * or is no longer in use.  (Effects can thus register cleanup functions with
 * {@link uneventful.must must()}, and use any other job-dependent APIs.)
 *
 * Effects are similar to rules, but they run immediately the first time they're
 * called (assuming they're observed), and rather than stopping manually (or
 * with their creating job), effects are reference-counted and only stop when
 * they're no longer in use.
 *
 * An effect is "in use" if it is:
 *
 * 1. Called from a rule (or a non-signal job) that has not yet ended, OR
 * 2. Invoked from another signal or effect that is in use
 *
 * When no active rules or jobs or in-use signals are referencing an effect, the
 * effect stops and runs any registered cleanups, closes stream connections,
 * etc.
 *
 * Unlike other signals, an effect also does not run *at all* if it is not "in
 * use". So if you have signals that are being queried but not observed, and
 * they invoke effects, the effects will not actually do anything until or
 * unless the calling signal is observed (e.g. via a rule or another in-use
 * effect).
 *
 * [^inline]: ```fx``(...)``` is shorthand for ```$``(() => fx(...))``` [^lazy].
 * That is, it acts just like any other call to `fx`, except that it only runs
 * at most once *per code location* in a given signal function.  The result is
 * then cached and returned for every subsequent call from that specific
 * location in the same signal function.
 *
 * [^lazy]: ```$``()``` is
 *     {@link uneventful/shared.$ the lazy constant operator}.  It allows for an
 *     expression to only be evaluated once during the life of an enclosing
 *     signal, by caching the result on its first invocation.
 *
 * [^dec]: Both TC39 decorators and "legacy" TypeScript/Babel decorators are
 *     supported.
 *
 * @beta
 */
export function fx<Instance extends WeakKey>(
    f: GetFactory<Instance> | Get<void> | Method<Instance> | TemplateStringsArray, ...args: any[]
): ((ob?: Instance) => void) | DeferredFx {
    if (args.length) {
        // @fx
        return decorateMethod(method => {
            const m = fx((ob: Instance) => method.bind(ob))
            return function(this: Instance) { m(this); }
        }, f as Method<Instance>, ...args as [any, any]);
    } else if (!isFunction(f)) {
        // fx``()
        return perSignal(fx, f, "fx``() ")
    } else if (f.length) {
        // fx(ob => () => {})
        const map = new WeakMap<Instance, Get<void>>();
        return (ob: Instance) => (map.get(ob) || setMap(map, ob, fx((f as GetFactory<Instance, void>)(ob))))()
    } else if (!isPlainFunction(f)) {
        throw new Error("fx() bodies must be plain functions, not signals, generators, or async")
    } else {
        // fx(() => {})
        let jobs: SetOrSingle<Job>, cell = Cell.mkCached(f as Get<void>)
        return () => {
            if (currentCell) {
                // Silent no-op if unobserved
                if (currentCell.isObserved()) cell.getValue()
            } else {
                // Called from job instead of signal - track active calling jobs and
                // activate or deactivate accordingly
                if (!sosHas(jobs, getJob())) {
                    const job = currentJob
                    jobs = sosAdd(jobs, job)
                    sosSize(jobs) > 1 || (cell.setQ(defaultQ), defaultQ.delete(cell))
                    must(() => {
                        jobs = sosDel(jobs, job)
                        if (!sosSize(jobs)) cell.setQ(null)
                    })
                }
                // Ensure that the effect is synchronously up-to-date
                cell.catchUp()
            }
        }
    }
}
