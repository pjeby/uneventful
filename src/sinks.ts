import { Job, Request, Suspend, Yielding } from "./types.ts"
import { defer } from "./defer.ts";
import { Connection, Inlet, Source, Sink, Stream, connect, pipe, throttle } from "./streams.ts";
import { resolve, isError, markHandled, isValue, fulfillPromise, rejecter, resolver } from "./results.ts";
import { restarting, start } from "./jobutils.ts";
import { getJob, isFunction } from "./tracking.ts";
import { Signal, cached } from "./signals.ts";

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
    const t = throttle(), conn = getJob().connect(src, v => {
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
 * Wait for and return the next truthy value (or error) from a data source (when
 * processed with `yield *` within a {@link Job}).
 *
 * This differs from {@link next}() in that it waits for the next "truthy" value
 * (i.e., not null, false, zero, empty string, etc.), and when used with signals
 * or a signal-using function, it can resume *immediately* if the result is
 * already truthy.  (It also supports zero-argument signal-using functions,
 * automatically wrapping them with {@link cached}(), as the common use case for
 * until() is to wait for an arbitrary condition to be satisfied.)
 *
 * @param source The source to wait on, which can be:
 * - An object with an `"uneventful.until"` method returning a {@link Yielding}
 *   (in which case the result will be the the result of calling that method)
 * - A {@link Signal}, or a zero-argument function returning a value based on
 *   signals (in which case the job resumes as soon as the result is truthy,
 *   perhaps immediately)
 * - A {@link Source} (in which case the job resumes on the next truthy value
 *   it produces
 *
 * (Note: if the supplied source is a function with a non-zero `.length`, it is
 * assumed to be a {@link Source}.)
 *
 * @returns a Yieldable that when processed with `yield *` in a job, will return
 * the triggered event, or signal value.  An error is thrown if event stream
 * throws or closes early, or the signal throws.
 *
 * @category Signals
 * @category Scheduling
 */
export function until<T>(source: UntilMethod<T> | Stream<T> | (() => T)): Yielding<T> {
    return callOrWait<T>(source, "uneventful.until", waitTruthy, recache);
}
function recache<T>(s: () => T) { return until(cached(s)); }
function waitTruthy<T>(job: Job<T>, v: T) { v && job.return(v); }

/**
 * Wait for and return the next value (or error) from a data source (when
 * processed with `yield *` within a {@link Job}).
 *
 * This differs from {@link until}() in that it waits for the *next* value
 * (truthy or not!), and it never resumes immediately for signals, but instead waits
 * for the signal to *change*.  (Also, it does not support zero-argument functions,
 * unless you wrap them with {@link cached}() first.)
 *
 * @param source The source to wait on, which can be:
 * - An object with an `"uneventful.next"` method returning a {@link Yielding}
 *   (in which case the result will be the the result of calling that method)
 * - A {@link Signal} or {@link Source} (in which case the job resumes on the
 *  next value it produces)
 *
 * (Note: if the supplied source has a non-zero `.length`, it is assumed to be a
 * {@link Source}.)
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

function callOrWait<T>(
    source: any, method: string, handler: (job: Job<T>, val: T) => void, noArgs: (f?: any) => Yielding<T>|void
) {
    if (source && isFunction(source[method])) return source[method]() as Yielding<T>;
    if (isFunction(source)) return (
        source.length === 0 ? noArgs(source) : false
    ) || start<T>(job => {
        connect(source as Source<T>, v => handler(job, v)).do(r => {
            if(isValue(r)) job.throw(new Error("Stream ended"));
            else if (isError(r)) job.throw(markHandled(r));
        });
    })
    mustBeSourceOrSignal();
}

function mustBeSourceOrSignal() { throw new TypeError("not a source or signal"); }

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
