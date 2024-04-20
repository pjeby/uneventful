import { Request, Suspend, Yielding, reject, resolve } from "./async.ts";
import { defer } from "./defer.ts";
import { Source, pause, resume, connect } from "./streams.ts";
import { isError } from "./tracking.ts";

type EachResult<T> = {
    item: T;
    next: Suspend<void>;
}

type Each<T> = IterableIterator<EachResult<T>>

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
    }).must(() => {
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
