import { Checkpoint, Future, Request, Work } from "./types.ts";

/**
 * Resolve a {@link Request} with a value.
 *
 * (For a curried version, see {@link resolver}.)
 *
 * @category Requests and Results
 */
export function resolve<T>(request: Request<T>, val: T) { request("next", val); }

/**
 * Reject a {@link Request} with a reason.
 *
 * (For a curried version, see {@link rejecter}.)
 *
 * @category Requests and Results
 */
export function reject(request: Request<any>, reason: any) { request("throw", undefined, reason); }

/**
 * Create a callback that will resolve the given {@link Request} with a value.
 *
 * @category Requests and Results
 */
export function resolver<T>(request: Request<T>): (val: T) => void { return request.bind(null, "next"); }

/**
 * Create a callback that will reject the given {@link Request} with a reason.
 *
 * @category Requests and Results
 */
export function rejecter(request: Request<any>): (err: any) => void { return request.bind(null, "throw", undefined); }


/**
 * A function that does nothing and returns void.
 *
 * @category Stream Consumers
 */
export function noop() {}

/**
 * A {@link Result} that provides a return() value.
 *
 * @category Types and Interfaces
 */
export type ValueResult<T> = {op: "next",    val: T,         err: undefined};

/**
 * A {@link Result} that indicates a throw()n or other error.
 *
 * @category Types and Interfaces
 */
export type ErrorResult    = UnhandledError | HandledError;

/**
 * An {@link ErrorResult} that hasn't yet been "handled" (by being passed to an
 * error-specific handler, converted to a promise, given to {@link markHandled},
 * etc.)
 *
 * @category Types and Interfaces
 */
export type UnhandledError = {op: "throw",   val: undefined, err: any};

/**
 * An {@link ErrorResult} that has been marked "handled" (by being passed to an
 * error-specific handler, converted to a promise, given to {@link markHandled},
 * etc.)
 *
 * @category Types and Interfaces
 */
export type HandledError   = {op: "throw",   val: null,      err: any};

/**
 * A {@link Result} that indicates the task was canceled by its creator (via
 * end() or a parent {@link Checkpoint}'s reset()).
 *
 * @category Types and Interfaces
 */
export type CancelResult   = {op: "cancel",  val: undefined, err: undefined};

/**
 * A result passed to a context's cleanup callbacks, or supplied by a future's
 * .{@link Future.result result}() method.
 *
 * You can inspect a Result using functions like {@link isCancel}(),
 * {@link isError}(), and {@link isValue}().  {@link getResult}() can be used to
 * unwrap the value or throw the error.
 *
 * @category Types and Interfaces
 */
export type Result<T> = ValueResult<T> | ErrorResult | CancelResult ;

/** @hidden @deprecated Please use {@link Result} instead */
export type JobResult<T> = Result<T>

function mkResult<T>(op: "next", val?: T): ValueResult<T>;
function mkResult(op: "throw", val: null, err: any): HandledError;
function mkResult(op: "throw", val: undefined, err: any): UnhandledError;
function mkResult(op: "cancel"): CancelResult;
function mkResult<T>(op: string, val?: T, err?: any): Result<T> {
    return {op, val, err} as Result<T>
}

/**
 * The {@link Result} used to indicate a canceled task.
 *
 * @category Requests and Results
 */
export const CancelResult = Object.freeze(mkResult("cancel"));

/**
 * Create a {@link ValueResult} from a value
 *
 * @category Requests and Results
 */
export function ValueResult<T>(val: T): ValueResult<T> { return mkResult("next", val); }

/**
 * Create an {@link ErrorResult} from an error
 *
 * @category Requests and Results
 */
export function ErrorResult(err: any): UnhandledError { return mkResult("throw", undefined, err); }

/**
 * Returns true if the given result is a {@link CancelResult}.
 *
 * @category Requests and Results
 */
export function isCancel(res: Result<any> | undefined): res is CancelResult {
    return res === CancelResult;
}

/**
 * Returns true if the given result is a {@link ValueResult}.
 *
 * @category Requests and Results
 */
export function isValue<T>(res: Result<T> | undefined): res is ValueResult<T> {
    return res ? res.op === "next" : false;
}

/**
 * Returns true if the given result is a {@link ErrorResult}.
 *
 * @category Requests and Results
 */
export function isError(res: Result<any> | undefined): res is ErrorResult {
    return res ? res.op === "throw" : false;
}

/**
 * Returns true if the given result is an {@link UnhandledError}.
 *
 * @category Requests and Results
 */
export function isUnhandled(res: Result<any> | undefined): res is UnhandledError {
    return isError(res) && res.val === undefined;
}

/**
 * Returns true if the given result is a {@link HandledError} (an
 * {@link ErrorResult} that has been touched by {@link markHandled}).
 *
 * @category Requests and Results
 */
export function isHandled(res: Result<any> | undefined): res is HandledError {
    return isError(res) && res.val === null;
}

/**
 * Return the error of an {@link ErrorResult} and mark it as handled. The
 * {@link ErrorResult} is mutated in-place to become a {@link HandledError}.
 *
 * @category Requests and Results
 */
export function markHandled(res: ErrorResult): any {
    res.val = null;
    return res.err;
}

/**
 * Get the return value from a {@link Result}, throwing an appropriate error
 * if the result isn't a {@link ValueResult}.
 *
 * @param res The result you want to unwrap.  Must not be undefined!
 *
 * @returns The value if the result is a {@link ValueResult}, or a thrown error
 * if it's an {@link ErrorResult}.  A {@link CancelError} is thrown if the
 * result is {@link CancelResult}.
 *
 * If the result is an error, it is marked as handled.
 *
 * @category Requests and Results
 */
export function getResult<T>(res: Result<T>): T {
    if (!isValue(res)) {
        res.op; // throw if not defined
        fulfillPromise(noop, e => { throw e; }, res);
    }
    return res.val as T;
}

/**
 * Fulfill a Promise from a {@link Result}
 *
 * If the result is a {@link CancelResult}, the promise is rejected with a
 * {@link CancelError}.  Otherwise it is resolved or rejected according to the
 * state of the result.
 *
 * @param resolve A value-taking function (first arg to `new Promise` callback)
 *
 * @param reject An error-taking function (second arg to `new Promise` callback)
 *
 * @param res The result you want to settle the promise with.  An error will be
 * thrown if it's undefined.
 *
 * If the result is an error, it is marked as handled.
 *
 * @category Requests and Results
 */
export function fulfillPromise<T>(resolve: (v: T) => void, reject: (e: any) => void, res: Result<T>) {
    if (isError(res)) reject(markHandled(res));
    else if (isCancel(res)) reject(new CancelError("Task canceled"));
    else resolve(res.val);
}

/**
 * Propagate a {@link Result} to another task via its {@link Work} context
 *
 * If the result is a {@link CancelResult}, the task will throw with a
 * {@link CancelError}.  Otherwise it is resolved or rejected according to the
 * state of the result.
 *
 * @param work The {@link Work} to complete.  If it's already completed or
 * canceled, nothing changes: the result is not propagated and the error (if
 * any) is not marked as handled.
 *
 * @param res The result you want to settle the work's Task with.  If the result
 * is an error, it is marked as handled.
 *
 * @category Requests and Results
 */
export function propagateResult<T>(work: Work<T>, res: Result<T>) {
    if (!work.cleaningUp()) fulfillPromise(work.return.bind(work), work.throw.bind(work), res);
}

/**
 * Error thrown when waiting for a result from a future that is canceled.
 *
 * If you `await`, `yield *`, `.then()`, `.catch()`, {@link getResult}() or
 * otherwise wait on the result of a future that is canceled, this is the type
 * of error you'll get.
 *
 * @category Errors
 */
export class CancelError extends Error {}
