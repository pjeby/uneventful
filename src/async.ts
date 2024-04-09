import { Source, connect } from "./streams.ts";
import { OptionalCleanup, isCancel, isError, start } from "./tracking.ts";

/**
 * A request for a value (or error) to be returned asynchronously.
 *
 * A request is like the inverse of a Promise: instead of waiting for it to
 * settle, you settle it by passing it to {@link resolve}() or {@link reject}().
 * Like a promise, it can only be settled once: resolving or rejecting it after
 * it's already resolved or rejected has no effect.
 *
 * Settling a request will cause the requesting job (or other code) to resume
 * immediately, running up to its next suspension or termination.  (Unless it's
 * settled while the requesting job is already on the call stack, in which case
 * the job will be resumed later.)
 *
 * (Note: do not call a Request directly, unless you want your code to maybe
 * break in future.  Use resolve or reject (or {@link resolver}() or
 * {@link rejecter}()), as 1) they'll shield you from future changes to this
 * protocol and 2) they have better type checking anyway.)
 *
 * @category Types and Interfaces
 */
export interface Request<T> {
    (op: "next" | "throw", val?: T, err?: any): void;
}

/**
 * Resolve a {@link Request} with a value.
 *
 * (For a curried version, see {@link resolver}.)
 *
 * @category Jobs and Scheduling
 */
export function resolve<T>(request: Request<T>, val: T) { request("next", val); }

/**
 * Reject a {@link Request} with a reason.
 *
 * (For a curried version, see {@link rejecter}.)
 *
 * @category Jobs and Scheduling
 */
export function reject(request: Request<any>, reason: any) { request("throw", undefined, reason); }

/**
 * Create a callback that will resolve the given {@link Request} with a value.
 *
 * @category Jobs and Scheduling
 */
export function resolver<T>(request: Request<T>): (val: T) => void { return request.bind(null, "next"); }

/**
 * Create a callback that will reject the given {@link Request} with a reason.
 *
 * @category Jobs and Scheduling
 */
export function rejecter(request: Request<any>): (err: any) => void { return request.bind(null, "throw", undefined); }


/**
 * A pausable computation that ultimately produces a value of type T.
 *
 * An item of this type can be used to either create a job of type T, or awaited
 * in a job via `yield *` to obtain the value.
 *
 * Any generator function that ultimately returns a value, implicitly returns a
 * Yielding of that type, but it's best to *explicitly* declare this so that
 * TypeScript can properly type check your yield expressions.  (e.g. `function
 * *(): Yielding<number> {}` for a generator function that ultimately returns a
 * number.)
 *
 * Generator functions implementing this type should only ever `yield *` to
 * things that are of Yielding type, such as {@link wait}(), {@link to}() or
 * {@link suspend}(), or other generators declared Yielding.
 *
 * @yields {@link Suspend}\<any>
 * @returns T
 *
 *
 * @category Types and Interfaces
 */
export type Yielding<T> = {[Symbol.iterator](): JobIterator<T>}

/**
 * An iterator yielding {@link Suspend} callbacks.  (An implementation detail of
 * the {@link Yielding} type.)
 *
 * @category Types and Interfaces
 */
export type JobIterator<T> = Iterator<Suspend<any>, T, any>

/**
 * An asynchronous operation that can be waited on by a {@link Job}.  (Normally
 * used as an argument to {@link suspend}().)
 *
 * When a {@link JobIterator} yields a Suspend, the job invokes it with a
 * {@link Request} that the Suspend can use to continue the job with a
 * result or an error.
 *
 * @see See {@link suspend}() for more details on how suspending works and
 * how suspend functions should behave.
 *
 * @category Types and Interfaces
 */
export type Suspend<T> = (request: Request<T>) => void;


/**
 * Convert a promise to something you can `yield *to()` in a job
 *
 * Much like `await valueOrPromiseLike` in an async function, using `yield
 * *to(valueOrPromiseLike)` in a {@link Job}'s generator function will return
 * the value or the result of the promise/promise-like object.
 *
 * @category Jobs and Scheduling
 */
export function *to<T>(p: Promise<T> | PromiseLike<T> | T) {
    return yield (res: Request<T>) => Promise.resolve(p).then(resolver(res), rejecter(res));
}

/**
 * Suspend a job until its parent flow ends, or is ended by an explicit return()
 * or throw() on the {@link Job} object.
 *
 * @category Jobs and Scheduling
 */
export function suspend(): Yielding<never>;

/**
 * Suspend a job until a request is settled
 *
 * @returns A {@link Yielding} of the return type, suitable for calling via
 * `yield *` inside a {@link Job}, or converting to a job via the {@link job}()
 * function.
 *
 * @param action A function that will be passed a {@link Request}. It should
 * arrange for the request to be settled (via {@link resolve} or
 * {@link reject}).
 *
 * Note: If no action is supplied (or the request is not settled), **the job
 * will be suspended until cancelled by outside forces**.  (Such as its
 * enclosing flow ending, or explicit throw()/return() calls on the Job
 * instance.)
 *
 * Also note that any subflows the Suspend creates (or cleanup callbacks it
 * registers) **will not be disposed/called until the *calling* job ends**.  So
 * any resources that won't be needed once the job is resumed should be
 * explicitly disposed of (e.g. by wrapping them in a flow whose stop you call)
 * before settling the request.  (Or just use {@link wait}(), which handles this
 * for you.)
 */
export function suspend<T>(action: (request: Request<T>) => unknown): Yielding<T>;
export function *suspend<T>(action: (request: Request<T>) => unknown = noop): Yielding<T> {
    return yield action;
};

/**
 * Wait for a callback, with automatic resource cleanup.
 *
 * @param action A function taking a {@link Request}. It should arrange to
 * {@link resolve} or {@link reject} the request.  It can optionally return a
 * cleanup function.
 *
 * The function is executed in a nested flow that will be cleaned up before the
 * Request is settled, thereby releasing any resources used by the function
 * or its callees.
 *
 * @returns A {@link Yielding} of appropriate type, suitable for calling via
 * `yield *` inside a {@link Job}, or converting to a job via the {@link job}()
 * function.
 *
 * @example
 *
 *```typescript
 *function waitForKeypress() {
 *    return wait<KeyboardEvent>(request => {
 *        connect(fromDomEvent(document, "keypress"), resolver(request));
 *    });
 *}
 *
 *job(function *() {
 *    const keyEvent = yield *waitForKeypress();
 *});
 *```
 *
 * @category Jobs and Scheduling
 */
export function *wait<T>(action: (request: Request<T>) => OptionalCleanup): Yielding<T> {
    return yield outer => {
        let called = false;
        start(stop => action((o, v, e) => called || (called=true, stop(), outer(o, v, e))));
    }
}

const noop = () => {};

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
 * @category Jobs and Scheduling
 */
export function until<T>(source: Waitable<T>): Yielding<T> {
    if (typeof (source as UntilMethod<T>)["uneventful.until"] === "function") {
        return (source as UntilMethod<T>)["uneventful.until"]();
    }
    if (typeof source["then"] === "function") {
        return to(source as PromiseLike<T>);
    }
    if (typeof source === "function") {
        return wait(r => {
            connect(source, resolver(r)).must(res => {
                if (!isCancel(res)) reject(r, isError(res) ? res.err : new Error("Stream ended"));
            });
        })
    }
    throw new TypeError("until(): must be signal, source, or then-able");
}
