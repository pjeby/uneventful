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
 * A {@link JobResult} that indicates the job was ended via a return() value.
 *
 * @category Types and Interfaces
 */
export type ValueResult<T> = {op: "next",    val: T,         err: undefined};

/**
 * A {@link JobResult} that indicates the job was ended via a throw() or other
 * error.
 *
 * @category Types and Interfaces
 */
export type ErrorResult    = {op: "throw",   val: undefined, err: any};

/**
 * A {@link JobResult} that indicates the job was canceled by its creator (via
 * end() or restart()).
 *
 * @category Types and Interfaces
 */
export type CancelResult   = {op: "cancel",  val: undefined, err: undefined};

/**
 * A result passed to a job's cleanup callbacks
 *
 * @category Types and Interfaces
 */
export type JobResult<T> = ValueResult<T> | ErrorResult | CancelResult ;

function mkResult<T>(op: "next", val?: T): ValueResult<T>;
function mkResult(op: "throw", val: undefined|null, err: any): ErrorResult;
function mkResult(op: "cancel"): CancelResult;
function mkResult<T>(op: string, val?: T, err?: any): JobResult<T> {
    return {op, val, err} as JobResult<T>
}

/**
 * The {@link JobResult} used to indicate a canceled job.
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
export function ErrorResult(err: any): ErrorResult { return mkResult("throw", undefined, err); }

/**
 * Returns true if the given result is a {@link CancelResult}.
 *
 * @category Requests and Results
 */
export function isCancel(res: JobResult<any> | undefined): res is CancelResult {
    return res === CancelResult;
}

/**
 * Returns true if the given result is a {@link ValueResult}.
 *
 * @category Requests and Results
 */
export function isValue<T>(res: JobResult<T> | undefined): res is ValueResult<T> {
    return res ? res.op === "next" : false;
}

/**
 * Returns true if the given result is a {@link ErrorResult}.
 *
 * @category Requests and Results
 */
export function isError(res: JobResult<any> | undefined): res is ErrorResult {
    return res ? res.op === "throw" : false;
}
