import { JobResult } from "./results.ts";

/**
 * An undefined or null value
 *
 * @category Types and Interfaces
 */
export type Nothing = undefined | null | void;

/**
 * A function without a `this`
 *
 * @category Types and Interfaces
 */
export type PlainFunction = (this: void, ...args: any[]) => any;

/**
 * Any function
 *
 * @category Types and Interfaces
 */
export type AnyFunction = (...args: any[]) => any;

/**
 * A cleanup function is a callback invoked when a job is ended or restarted.
 * It receives a result that indicates whether the job ended itself with a return
 * value or error, or was canceled/restarted by its creator.
 *
 * @category Types and Interfaces
 */
export type CleanupFn<T=any> = (res: JobResult<T>) => unknown;

/**
 * A function that can be called to dispose of something or unsubscribe
 * something.  It's called without arguments and returns void.
 *
 * @category Types and Interfaces
 */
export type DisposeFn = () => void;

/**
 * An optional cleanup parameter or return.
 *
 * @category Types and Interfaces
 */
export type OptionalCleanup<T=any> = CleanupFn<T> | Nothing;

/**
 * An asynchronous start function is called immediately in the new job and must
 * return a {@link StartObj}, such as a job, generator, or promise.  If a job or
 * promise is returned, it will be awaited and its result used to asynchronously
 * set the result of the returned job.
 *
 * If a generator is returned, it will be run asynchronously, in the context of
 * the newly-started job.  Any result it returns or error it throws will be
 * treated as the result of the job.  If the job is canceled, the iterator's
 * `.return()` method will be called to abort it (thereby running any
 * try-finally clauses in the generator), and the result of the call will be
 * otherwise ignored.
 *
 * @template T The type the job will end up returning
 * @template This The type of `this` the function accepts, if using two-argument
 * start().  Defaults to void (for one-argument start()).
 *
 * @category Types and Interfaces
 */
export type AsyncStart<T, This=void> = (this: This, job: Job<T>) => StartObj<T>;

/**
 * A synchronous start function returns void. It runs immediately and gets
 * passed the newly created job as its first argument.
 *
 * @template T The type the job will end up returning
 * @template This The type of `this` the function accepts, if using two-argument
 * start().  Defaults to void (for one-argument start()).
 *
 * @category Types and Interfaces
 */
export type SyncStart<T, This=void>  = (this: This, job: Job<T>) => void;

/**
 * A synchronous or asynchronous initializing function for use with the
 * {@link start}() function or a job's {@link Job.start .start}() method.
 *
 * @template T The type the job will end up returning
 * @template This The type of `this` the function accepts, if using two-argument
 * start().  Defaults to void (for one-argument start()).
 *
 * @category Types and Interfaces
 */
export type StartFn<T, This=void> = AsyncStart<T,This> | SyncStart<T,This>

/**
 * An object that can be passed as a single argument to {@link start}() or a
 * job's {@link Job.start .start}() method, such as a job, generator, or
 * promise.
 *
 * @category Types and Interfaces
 */
export type StartObj<T> = Yielding<T> | Promise<T> | PromiseLike<T>

/**
 * A cancellable asynchronous operation with automatic resource cleanup.
 *
 * You can add cleanup callbacks to a job via {@link must}() or its
 * .{@link must}() method.  When the job is ended or canceled, the callbacks
 * are (synchronously) run in reverse order -- a bit like a delayed and
 * distributed collection of `finally` blocks.
 *
 * Jobs implement the Promise interface (then, catch, and finally) so they can
 * be passed to Promise-using APIs or awaited by async functions.  They also
 * implement {@link Yielding}, so you can await their results from a
 * {@link start}() using `yield *`.  They also have
 * {@link Job.return \.return()} and {@link Job.throw \.throw()} methods so
 * you can end a job with a result or error.
 *
 * Most jobs, however, are not intended to produce results, and are merely
 * canceled (using {@link Job.end \.end()} or
 * {@link Job.restart \.restart()}).
 *
 * Jobs can be created and accessed using {@link start}(),
 * {@link detached}.start(), {@link makeJob}(), and {@link getJob}().
 *
 * @category Types and Interfaces
 */
export interface Job<T=any> extends Yielding<T>, Promise<T> {
    /**
     * The result of the job (canceled, returned value, or error), or
     * undefined if the job isn't finished.
     *
     * @category Obtaining Results
     */
    result(): JobResult<T> | undefined;

    /**
     * Add a cleanup callback to be run when the job is ended or restarted.
     * (Non-function values are ignored.)  If the job has already ended, the
     * callback will be invoked asynchronously in the next microtask. Cleanup
     * functions are run in LIFO order, after any {@link Job.release}()
     * callbacks (including those of the job's children), but before any
     * {@link Job.do}() callbacks are run for the same job.
     *
     * Generally speaking, this method is used within a job to arrange for used
     * resources to be cleaned up or to undo other state that was only supposed
     * to be active while the job was running.
     *
     * @category Resource Tracking
     */
    must(cleanup?: OptionalCleanup<T>): this;

    /**
     * Create a mutual-cleanup link with a resource that might be stopped or
     * terminated in some way before the job ends. (Like a child process, a
     * server connection, etc.)
     *
     * If a job uses a lot of such resources, using {@link Job.must} callbacks
     * to trigger each one would result in an ever growing number of callbacks
     * (and uncollectable reference to the no-longer-usable resources).  So this
     * method lets you *remove* a cleanup function when it's no longer needed:
     * when the resource is closed or finished, invoking the callback returned
     * by this method will remove the cleanup callback from the job, allowing
     * the resource to be freed before the job ends, without accumulating an
     * endless number of callbacks in the job.  (Uneventful also uses this
     * mechanism internally to link child jobs to their parents.)
     *
     * In order to ensure that all such "child" jobs, resources, and activities
     * are marked as canceled *before* any side effects (such as events,
     * callbacks or I/O operations) can occur, Uneventful prioritizes *all*
     * release callbacks to run before *any* other callbacks of any kind.  since
     * release callbacks are used for child jobs, this means that the entire job
     * subtree is notified immediately of cancellation, before any other actions
     * are taken.  This ensures that no "stray" operations can continue, unaware
     * that their job is canceled.
     *
     * This means, however, that release callbacks must do **only** simple
     * actions that **can't** result in arbitrary code being synchronously run.
     * (Some safe examples would be setting flags, cancelling event
     * subscriptions, removing things from internal queues, etc.)  Synchronously
     * triggering events or other callbacks, however, runs the risk of that code
     * doing things it wouldn't have done if it knew its job were canceled.
     *
     * Note that if you still need such actions to happen, your release callback
     * can always add a new {@link Job.must}() or {@link Job.do}() callback at
     * that point, and the callback will then get done during a later phase of
     * job cleanup, without losing the benefits of the mutual-cleanup process.
     *
     * @param cleanup A cleanup callback.  It will receive a {@link JobResult},
     * and its return value is ignored.
     *
     * @returns A callback that should be used to remove the passed-in cleanup
     * callback from the job, if the resource is disposed of before the job
     * ends.
     *
     * @category Resource Tracking
     */
    release(cleanup: CleanupFn<T>): DisposeFn;

    /**
     * Start a nested job using the given function (or {@link Yielding},
     * promise, etc.). (Like {@link start}(), but using a specific job as the
     * parent, rather than whatever job is active.  Zero, one, and two arguments
     * are supported, just as with start().)
     *
     * @category Execution Control
     */
    start<T>(init?: StartFn<T> | StartObj<T>): Job<T>;
    start<T, This>(thisArg: This, fn: StartFn<T, This>): Job<T>;

    /**
     * Invoke a function with this job as the active one, so that calling the
     * global {@link must} function will add cleanup callbacks to it,
     * {@link getJob} will return it, etc.  (Note: signal dependency tracking is
     * disabled for the duration of the call.)
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     *
     * @category Execution Control
     */
    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Wrap a function so this job will be active when it's called.
     *
     * @param fn The function to wrap
     *
     * @returns A function with the same signature(s), but will have this job
     * active when called.
     *
     * @remarks Note that if the supplied function has any custom properties,
     * they will *not* be available on the returned function at runtime, even
     * though TypeScript will act as if they are present at compile time.  This
     * is because the only way to copy all overloads of a function signature is
     * to copy the exact type (as TypeScript has no way to generically say,
     * "this a function with all the same overloads, but none of the
     * properties").
     *
     * @category Execution Control
     */
    bind<F extends (...args: any[]) => any>(fn: F): F

    /**
     * Release all resources held by the job.
     *
     * Arrange for all cleanup functions and result consumers added to the job
     * (via release, must, do, etc.) be called in the appropriate order.  When
     * the call to end() returns, all child jobs will have been notified of
     * their cancellation.  (But not all of their cleanups or result consumers
     * may have run yet, in the event that another job's end() is in progress
     * when this method is called.)
     *
     * If any callbacks throw exceptions, they're converted to unhandled promise
     * rejections (so that all of them will be called, even if one throws an
     * error).
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another job, event source, etc.
     *
     * @category Execution Control
     */
    readonly end: () => void;

    /**
     * Invoke a callback with the result of a job.  Similar to
     * {@link Job.must}(), except that `do` callbacks run in FIFO order after
     * all {@link Job.must}() and {@link Job.release}() callbacks are done for
     * the same job.
     *
     * These callbacks are used internally to implement promises, and should
     * generally be used when you want to perform actions based on the *result*
     * of a job.  (Whereas {@link Job.must}() callbacks are intended to clean up
     * resources used by the job itself, and {@link Job.release}() callbacks are
     * used to notify other activities (such as child jobs) that they are being
     * canceled.)
     *
     * @remarks The .{@link Job.onError onError}(),  .{@link Job.onError onValue}(),
     * and .{@link Job.onError onCancel}() provide shortcuts for creating `do`
     * callbacks that only run under specific end conditions.
     *
     * @category Obtaining Results
     */
    do(action: (res?: JobResult<T>) => unknown): this;

    /**
     * Invoke a callback if the job ends with an error.
     *
     * This is shorthand for a .{@link Job.do do}() callback that checks for an
     * error and marks it handled, so it uses the same relative order and runs
     * in the same group as other .do callbacks.
     *
     * @param cb A callback that will receive the error
     *
     * @category Obtaining Results
     */
    onError(cb: (err: any) => unknown): this;

    /**
     * Invoke a callback if the job ends with a return() value.
     *
     * This is shorthand for a .{@link Job.do do}() callback that checks for a
     * value result, so it uses the same relative order and runs in the same
     * group as other .do callbacks.
     *
     * @param cb A callback that will receive the value
     *
     * @category Obtaining Results
     */
    onValue(cb: (val: T) => unknown): this;

    /**
     * Invoke a callback if the job ends with an cancellation or
     * .{@link Job.restart restart}().
     *
     * This is shorthand for a .{@link Job.do do}() callback that checks for an
     * error and marks it handled, so it uses the same relative order and runs
     * in the same group as other .do callbacks.
     *
     * @param cb A callback that will receive the error
     *
     * @category Obtaining Results
     */
    onCancel(cb: () => unknown): this;

    /**
     * Restart this job - works just like .{@link Job.end end}(), except that
     * the job isn't ended, so cleanup callbacks can be added again and won't be
     * invoked until the next restart or the job is ended.  Note that the job's
     * startup code will *not* be rerun: this just runs an early cleanup and
     * then "uncancels" the job, changing its {@link Job.result result}() from
     * {@link CancelResult} back to undefined.  It's up to you to do any needed
     * re-initialization.
     *
     * Unlinke .{@link Job.end end}(), restart() guarantees that *all* cleanups
     * and result consumers for the target job will have completed running when
     * it returns.
     *
     * @see The {@link restarting} wrapper can be used to make a function that
     * runs over and over in the same job, restarting each time.
     *
     * @category Execution Control
     */
    restart(): this;

    /**
     * Informs a job of an unhandled error from one of its children.
     *
     * If the job has an .{@link Job.asyncCatch asyncCatch}() handler set, it
     * will be called with the error, otherwise the job will end with the
     * supplied error.  If the error then isn't handled by a listener on the
     * job, the error will cascade to an asyncThrow on the job's parent, until
     * the {@link detached} job and its asyncCatch handler is reached. (Which
     * defaults to creating an unhandled promise rejection.)
     *
     * Note: application code should not normally need to call this method
     * directly, as it's automatically invoked on a job's parent if the job
     * fails with no error listeners.  (That is, if a job result isn't awaited
     * by anything and has no onError handlers, and the job throws, then the
     * error is automatically asyncThrow()n to the job's parent.)
     *
     * @param err The error thrown by the child job
     *
     * @category Handling Errors
     */
    asyncThrow(err: any): this;

    /**
     * Set up a callback to receive unhandled errors from child jobs.
     *
     * Setting an async-catch handler allows you to create robust parent jobs
     * that log or report errors and restart either a single job or an entire
     * group of them, in the event that a child job malfunctions in a way that's
     * not caught elsewhere.
     *
     * @param handler Either an error-receiving callback, or null.  If null,
     * asyncThrow()n errors for the job will be passed to the job's throw()
     * method instead.  If a callback is given, it's called with `this` bound to
     * the relevant job instance.
     *
     * @category Handling Errors
     */
    asyncCatch(handler: ((this: Job, err: any) => unknown) | null): this;

    /**
     * End the job with a thrown error, passing an {@link ErrorResult} to the
     * cleanup callbacks.  (Throws an error if the job is already ended or is
     * currently restarting.)  Provides the same execution and ordering
     * guarantees as .{@link Job.end end}().
     *
     * Note: since this immediately ends the job with an error, it should only
     * be called by the job when it is no longer able to continue.  If you want
     * to notify a job about an error in a *different* job, you may want to use
     * .{@link Job.asyncThrow asyncThrow}() instead.
     *
     * @category Producing Results
     */
    throw(err: any): this;

    /**
     * End the job with a return value, passing a {@link ValueResult} to the
     * cleanup callbacks.  (Throws an error if the job is already ended or is
     * currently restarting.)  Provides the same execution and ordering
     * guarantees as .{@link Job.end end}().
     *
     * @category Producing Results
     */
    return(val: T) : this;

}

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
 * things that are of Yielding type, such as a {@link Job}, {@link to}() or
 * other generators declared Yielding.
 *
 * @yields {@link Suspend}\<any>
 * @returns T
 *
 *
 * @category Types and Interfaces
 */
export type Yielding<T> = {
    /**
     * An iterator suitable for use with `yield *` (in a job generator) to
     * obtain a result.
     *
     * @category Obtaining Results
     */
    [Symbol.iterator](): JobIterator<T>
}

/**
 * An iterator yielding {@link Suspend} callbacks.  (An implementation detail of
 * the {@link Yielding} type.)
 *
 * @category Types and Interfaces
 */
export type JobIterator<T> = Generator<Suspend<any>, T, any>

/**
 * An asynchronous operation that can be waited on by a {@link Job}.
 *
 * When a {@link JobIterator} yields a Suspend, the job invokes it with a
 * {@link Request}.  The Suspend function should arrange for the request to be
 * settled (via {@link resolve} or {@link reject}).
 *
 * Note: If the request is not settled, **the job will be suspended until
 * cancelled by outside forces**.  (Such as its enclosing job ending, or
 * explicit throw()/return() calls on the job instance.)
 *
 * Also note that any subjobs the Suspend function creates (or cleanup callbacks
 * it registers) **will not be called until the *calling* job ends**.  So any
 * resources that won't be needed once the job is resumed should be explicitly
 * disposed of -- in which case you should probably just `yield *` to a
 * {@link start}(), instead of yielding a Suspend!
 *
 * @category Types and Interfaces
 */
export type Suspend<T> = (request: Request<T>) => void;

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
    (op: "next", val: T, err?: any): void;
    (op: "throw", val: undefined | null, err: any): void;
    (op: "next" | "throw", val?: T | undefined | null, err?: any): void;
}

/**
 * A subscribable function used to trigger signal recalculations
 *
 * It must accept a callback, and should arrange (via {@link must}()) to
 * unsubscribe when its calling job ends.  Once subscribed, it should
 * invoke the callback to trigger recalculation of the signal(s) that
 * were targeted via {@link recalcWhen}.
 *
 * @category Types and Interfaces
 */
export type RecalcSource = ((cb: ()=>void) => unknown);
