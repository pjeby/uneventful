import { Request, Suspend, Yielding} from "./types.ts"
import { to } from "./async.ts";
import { defer } from "./defer.ts";
import { Source, pause, resume, connect } from "./streams.ts";
import { reject, resolve, isCancel, isError } from "./results.ts";
import { start } from "./jobutils.ts";
import { isFunction } from "./tracking.ts";

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
export function *each<T>(src: Source<T>): Yielding<Each<T>> {
    let yielded = false, waiter: Request<void>;
    const result: IteratorYieldResult<EachResult<T>> = {value: {item: undefined as T, next}, done: false};
    const conn = connect(src, v => {
        pause(conn);
        if (!waiter || conn.result()) return;
        result.value.item = v;
        resolve(waiter, waiter = void 0);
    }).do(() => {
        if (waiter) { defer(next.bind(null, waiter)); waiter = undefined; }
    });

    // Wait for first value to arrive (and get put in result) before returning the iterator
    pause(conn); yield next;
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
            isError(conn.result()) ? reject(r, conn.result().err) : resolve(r, void 0);
        } else {
            waiter = r;
            resume(conn);
        }
    }
}

/**
 * An object that can be waited on with `yield *until()`.
 *
 * @category Types and Interfaces
 */
export type Waitable<T> = UntilMethod<T> | Source<T> | Promise<T> | PromiseLike<T>;

/**
 * An object that can be waited on with `yield *until()`, by calling its
 * "uneventful.until" method.
 *
 * @category Types and Interfaces
 */
export interface UntilMethod<T> {
    "uneventful.until"(): Yielding<T>
}

/**
 * Wait for and return next value (or error) from a data source when processed
 * with `yield *` within a {@link Job}.
 *
 * @param source A {@link Waitable} data source, which can be any of:
 * - A {@link Signal} (in which case the job will resume when the value is
 *   truthy - perhaps immediately!)
 * - A {@link Source}
 * - A promise, or promise-like object with a `.then()` method
 * - An object with an `"uneventful.until"` method returning a {@link Yielding}
 *   (in which case the result will be the the result of that method)
 *
 * @returns a Yieldable that when processed with `yield *` in a job, will return
 * the triggered event, promise resolution, or signal value.  An error is thrown
 * if the promise rejects or the event stream throws or closes early, or the
 * signal throws.
 *
 * @category Scheduling
 */
export function until<T>(source: Waitable<T>): Yielding<T> {
    if (isFunction((source as UntilMethod<T>)["uneventful.until"])) {
        return (source as UntilMethod<T>)["uneventful.until"]();
    }
    if (isFunction(source["then"])) {
        return to(source as PromiseLike<T>);
    }
    if (isFunction(source)) {
        return start(job => {
            connect(source, e => job.return(e)).do(res => {
                if (!isCancel(res) && !job.result()) job.throw(isError(res) ? res.err : new Error("Stream ended"));
            });
        })
    }
    throw new TypeError("until(): must be signal, source, or then-able");
}
