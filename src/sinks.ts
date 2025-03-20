import { Job, RecalcSource, Request, Suspend, Yielding } from "./types.ts"
import { defer } from "./defer.ts";
import { Connection, Inlet, Sink, Stream, connect, pipe, throttle } from "./streams.ts";
import { resolve, isError, markHandled, fulfillPromise, rejecter, resolver } from "./results.ts";
import { restarting, start, must } from "./jobutils.ts";
import { isFunction } from "./utils.ts";
import { Signal, until, cached } from "./signals.ts";  // the until and cached are needed for documentation links
import { callOrWait, mustBeSourceOrSignal } from "./call-or-wait.ts";
import { currentCell } from "./ambient.ts";

/**
 * The result type returned from calls to {@link Each}.next()
 *
 * @category Types and Interfaces
 */
export type EachResult<T> = {
    /** The value provided by the source being iterated */
    item: T;

    /**
     * A suspend callback that must be `yield`-ed before the next call to the
     * iterator's .next() method. (That is, you must `yield next` it exactly once
     * per loop pass.  See {@link each}() for more details.)
     */
    next: Suspend<void>;
}

/**
 * The iterable returned by `yield *` {@link each}()
 *
 * @category Types and Interfaces
 */
export type Each<T> = IterableIterator<EachResult<T>>

/**
 * Asynchronously iterate over an event source
 *
 * Usage:
 *
 * ```ts
 * for (const {item: event, next} of yield *each(mouseMove)) {
 *     console.log(event.clientX, event.clientY);
 *     yield next;  // required exactly once per iteration, even/w continue!
 * }
 * ```
 *
 * each(eventSource) yield-returns an iterator of `{item, next}` pairs.  The
 * item is the data supplied by the event source, and `next` is a
 * {@link Suspend}\<void\> that advances the iterator to the next item.  It
 * *must* be yielded exactly once per loop iteration.  If you use `continue` to
 * shortcut the loop body, you must `yield next` *before* doing so.
 *
 * The for-loop will end if the source ends, errors, or is canceled.  The source
 * is paused while the loop body is running, and resumed when the `yield next`
 * happens.  If events arrive anyway (e.g. because the source doesn't support
 * pausing), they will be ignored unless you pipe the source through the
 * {@link slack}() operator to provide a buffer. If the for-loop is exited
 * early for any reason (or the iterator's `.return()` is called), the source is
 * unsubscribed and the iteration ended.
 *
 * @category Stream Consumers
 */
export function *each<T>(src: Stream<T>): Yielding<Each<T>> {
    let yielded = false, waiter: Request<void>;
    const result: IteratorYieldResult<EachResult<T>> = {value: {item: undefined as T, next}, done: false};
    const t = throttle(), conn = connect(src, v => {
        t.pause();
        if (!waiter || conn.result()) return;
        result.value.item = v;
        resolve(waiter, waiter = void 0);
    }, t).do(r => {
        // Prevent unhandled throws from here - it'll be seen by the next `yield
        // next`, or in the next microtask if `yield next` is already running.
        if (isError(r)) markHandled(r);
        if (waiter) { defer(next.bind(null, waiter)); waiter = undefined; }
    });

    // Wait for first value to arrive (and get put in result) before returning the iterator
    t.pause(); yield next;
    return {
        [Symbol.iterator]() { return this; },
        next() {
            if (!yielded) throw new Error("Must `yield next` in loop");
            yielded = false;
            return result;
        },
        return() { conn.end(); return {value: undefined, done: true}; },
    }
    function next(r: Request<void>) {
        if (waiter) throw new Error("Multiple `yield next` in loop");
        yielded = true;
        if (conn.result()) {
            result.value = undefined;
            (result as IteratorResult<any>).done = true;
            fulfillPromise(resolver(r), rejecter(r), conn.result())
        } else {
            waiter = r;
            t.resume();
        }
    }
}

/**
 * An object that can be waited on with `yield *until()`, by calling its
 * "uneventful.until" method.  (This mostly exists to allow Signals to optimize
 * their until() implementation, but is also open for extensions.)
 *
 * @category Types and Interfaces
 */
export interface UntilMethod<T> {
    /** Return an async op to resume once a truthy value is available */
    "uneventful.until"(): Yielding<T>
}

/**
 * An object that can be waited on with `yield *next()`, by calling its
 * "uneventful.next" method.  (This mostly exists to allow Signals to optimize
 * their next() implementation, but is also open for extensions.)
 *
 * @category Types and Interfaces
 */
export interface NextMethod<T> {
    /** Return an async op to resume with the "next" (i.e. not current) value produced */
    "uneventful.next"(): Yielding<T>
};

/**
 * Wait for and return the next value (or error) from a data source (when
 * processed with `yield *` within a {@link Job}).
 *
 * This differs from {@link until}() in that it waits for the *next* value
 * (truthy or not!), and it never resumes immediately for signals, but instead
 * waits for the signal to *change*.  (Also, it does not support zero-argument
 * functions, unless you wrap them with {@link cached}() first.)
 *
 * @param source The source to wait on, which can be:
 * - An object with an `"uneventful.next"` method returning a {@link Yielding}
 *   (in which case the result will be the the result of calling that method)
 * - A {@link Signal} or {@link Source} (in which case the job resumes on the
 *   next value it produces)
 *
 * (Note: if the supplied source is a function with a non-zero `.length`, it is
 * assumed to be a {@link Source}.)
 *
 * @returns a Yieldable that when processed with `yield *` in a job, will return
 * the triggered event, or signal value.  An error is thrown if event stream
 * throws or closes early, or the signal throws.
 *
 * @category Stream Consumers
 * @category Scheduling
 */
export function next<T>(source: NextMethod<T> | Stream<T>): Yielding<T> {
    return callOrWait<T>(source, "uneventful.next", waitAny, mustBeSourceOrSignal);
}

function waitAny<T>(job: Job<T>, v: T) { job.return(v); }

/**
 * Run a {@link restarting}() callback for each value produced by a source.
 *
 * With each event that occurs, any previous callback run is cleaned up before
 * the new one begins.  (And the last run is cleaned up when the connection or
 * job ends.)
 *
 * This function is almost the exact opposite of {@link each}(), in that the
 * stream is never paused (unless you do so manually via a throttle or inlet),
 * and if the "loop body" (callback job) is still running when a new value
 * arrives, forEach() restarts the job instead of dropping the value.
 *
 * @param src An event source (i.e. a {@link Source} or {@link Signal})
 * @param sink A callback that receives values from the source
 * @param inlet An optional throttle or inlet that will be used to pause the
 * source (if it's a signal or supports backpressure)
 * @returns a {@link Connection} that can be used to detect the stream
 * end/error, or ended to close it early.
 *
 * @category Stream Consumers
 */
export function forEach<T>(src: Stream<T>, sink: Sink<T>, inlet?: Inlet): Connection;
/**
 * When called without a source, return a callback suitable for use w/{@link pipe}().
 * e.g.:
 *
 * ```ts
 * pipe(someSource, ..., forEach(v => { doSomething(v); }), optionalInlet));
 * ```
 *
 */
export function forEach<T>(sink: Sink<T>, inlet?: Inlet): (src: Stream<T>) => Connection;
export function forEach<T>(
    src: Stream<T>|Sink<T>, sink?: Sink<T>|Inlet, inlet?: Inlet
): Connection | ((src: Stream<T>) => Connection) {
    if (isFunction(sink)) return start(j => {
        (src as Stream<T>)(restarting(sink as Sink<T>), j, inlet)
    });
    inlet = sink as Inlet; sink = src as Sink<T>;
    return (src: Stream<T>) => forEach(src, sink as Sink<T>, inlet);
}

/**
 * Arrange for the current signal or rule to recalculate on demand
 *
 * This lets you interop with systems that have a way to query a value and
 * subscribe to changes to it, but not directly produce a signal.  (Such as
 * querying the DOM state and using a MutationObserver.)
 *
 * By calling this with a {@link Source} or {@link RecalcSource}, you arrange
 * for it to be subscribed, if and when the call occurs in a rule or a cached
 * function that's in use by a rule (directly or indirectly).  When the source
 * emits a value, the signal machinery will invalidate the caching of the
 * function or rule, forcing a recalculation and subsequent rule reruns, if
 * applicable.
 *
 * Note: you should generally only call the 1-argument version of this function
 * with "static" sources - i.e. ones that won't change on every call. Otherwise,
 * you will end up creating new signals each time, subscribing and unsubscribing
 * on every call to recalcWhen().
 *
 * If the source needs to reference some object, it's best to use the 2-argument
 * version (i.e. `recalcWhen(someObj, factory)`, where `factory` is a function
 * that takes `someObj` and returns a suitable {@link RecalcSource}.)
 *
 * @remarks
 * recalcWhen is specifically designed so that using it does not pull in any
 * part of Uneventful's signals framework, in the event a program doesn't
 * already use it.  This means you can use it in library code to provide signal
 * compatibility, without adding bundle bloat to code that doesn't use signals.
 *
 * @category Signals
 */

export function recalcWhen(src: RecalcSource): void;
/**
 * Two-argument variant of recalcWhen
 *
 * In certain circumstances, you may wish to use recalcWhen with a source
 * related to some object.  You could call recalcWhen with a closure, but that
 * would create and discard signals on every call.  So this 2-argument version
 * lets you avoid that by allowing the use of an arbitrary object as a key,
 * along with a factory function to turn the key into a {@link RecalcSource}.
 *
 * @param key an object to be used as a key
 *
 * @param factory a function that will be called with the key to obtain a
 * {@link RecalcSource}.  (Note that this factory function must also be a static
 * function, not a closure, or the same memory thrash issue will occur!)
 */
export function recalcWhen<T extends WeakKey>(key: T, factory: (key: T) => RecalcSource): void;
export function recalcWhen<T extends WeakKey>(fnOrKey: T | RecalcSource, fn?: (key: T) => RecalcSource) {
    currentCell?.recalcWhen<T>(fnOrKey as T, fn);
}

/**
 * Find out whether the active signal is being observed, or just queried.
 *
 * If the return value is true, the caller is running within a signal
 * calculation that is being observed by subscribers (such as a rule or stream
 * listener).  If the return value is false, the caller is running within a
 * signal calculation that is *not* observed by any subscribers, and the signal
 * will be recalculated whenever it transitions from unobserved to observed.
 *
 * Returns `undefined` if the caller isn't running in a signal calculation.
 *
 * @remarks Note that calling this function within a signal calculation even
 * once adds a *permanent*, implicit dependency to that signal, on whether the
 * signal is being observed.  (As does using any job APIs directly.)
 *
 * The assumption here is that if you're checking whether it's observed, it's
 * because you only want to do certain things *while* it's being observed, so
 * the signal needs to be recalculated when it *starts* being observed, so you
 * can do those things.  (If you need to undo or clean up those things when the
 * signal is no-longer observed, you can register a cleanup callback via e.g.
 * {@link must}(), or wrap them in a sub-job with start, connect, etc.)
 *
 * @category Signals
 */
export function isObserved(): boolean | undefined  {
    return currentCell?.isObserved();
}
