import { Result } from "./results.ts";
import { Inlet, Sink, Stream, Throttle } from "./streams.ts";
import { start, starting, restarting } from "./jobutils.ts";
import { peek } from "./signals.ts";
import { boundTo } from "./utils.ts";

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
 * A cleanup function is a callback invoked when a cleanup context is ended
 * or reset. It receives a result that indicates whether the context ended
 * itself with a return value or error, or was canceled/reset by its
 * creator.
 *
 * @category Types and Interfaces
 */
export type CleanupFn<T=unknown> = (res: Result<T>) => unknown;

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
export type OptionalCleanup<T=unknown> = CleanupFn<T> | Nothing;

/**
 * An {@link Activity} function that returns an {@link Eventual} value (such as
 * a {@link Coroutine} or a promise/promiselike object).
 *
 * The function is passed a task's {@link Work} context, so it can e.g. set an
 * .{@link Scope.asyncCatch asyncCatch}() handler, or explicitly complete or
 * fail the task.
 *
 * If you use a generator function for this, and are using the `work` or `self`
 * parameter, TypeScript isn't always able to guess what type that parameter
 * should have, and may guess incorrectly.  In such cases it usually suffices to
 * supply the type explicitly *somewhere*, via e.g.
 * `start<number>(function*(work) {...})` or
 * `starting<string>(function*(self){...})`.
 *
 * Note, too, that generator functions **do not** start executing until a
 * microtask *after* the one where they are started or exec()'d.  See
 * {@link Coroutine} for more detail.
 *
 * @template T The type this activity returns
 *
 * @template This The type of `this` the function accepts, if using the
 * deprecated two-argument start() form, or {@link boundTo}().
 *
 * @category Types and Interfaces
 */
export type EventuallyReturns<T, This=void> = (this: This, work: Work<T>) => Eventual<T>

/**
 * An {@link Activity} function that sets up event listeners, effects, or other
 * ways to do the work of a task, optionally marking the work as completed.
 *
 * The function is passed a task's {@link Work} context, so it can complete or
 * fail the task, set an .{@link Scope.asyncCatch asyncCatch}() handler, etc.
 *
 * If you don't specify otherwise, the work's default return type is usually
 * `never`, meaning the task or activity never "finishes" with a result, but
 * simply exits if fails or is canceled (e.g. due to another activity completing
 * the task).
 *
 * @template T The type this activity returns
 *
 * @template This The type of `this` the function accepts, if using the
 * deprecated two-argument start() form, or {@link boundTo}().
 *
 * @category Types and Interfaces
 */
export type Setup<T, This=void>  = (this: This, work: Work<T>) => OptionalCleanup;

/**
 * An function implementing a {@link Task}, or an {@link Activity} within a task
 *
 * An activity function is a function run within a task's {@link Scope} and
 * passed its {@link Work}.  Either the function:
 *
 * 1. Does the work itself (e.g. as a generator function returning a
 *    {@link Coroutine}, or an async function returning a Promise),
 *
 * 2. Delegates it to a returned {@link Eventual} value, or
 *
 * 3. Synchronously *sets up* the activity (by wiring listeners, signals, etc.),
 *    to eventually call `work.return()` or `work.throw()` to finish the task.
 *    (If applicable, that is! Some tasks or activities are simply meant to run
 *    until canceled.)  A synchronous {@link Setup} function can also return an
 *    optional cleanup function, in lieu of passing it to `must()`.
 *
 * @template T The type of result the function produces; use `never` for an
 * activity that keeps running until canceled and won't ever call
 * `work.return()` either.
 *
 * @template This The type of `this` the function accepts, if using the
 * deprecated two-argument `start()` form, or {@link boundTo}().
 *
 * @remarks When you create an activity function that takes an explicit `work`
 * or `self` argument (to receive the work context), you need to either
 * explicitly type it (e.g. `function*(self: Work<number>){}`) or provide a type
 * parameter to the thing you're calling it with (e.g.
 * `start<number>(function*(self){...})`), or you'll end up with a
 * `Work<unknown>`, which is probably not what you want.
 *
 * @category Types and Interfaces
 */
export type ActivityFn<T, This=void> = EventuallyReturns<T,This> | Setup<T,This>

/**
 * An object that eventually produces a value (such as a {@link Coroutine},
 * {@link Task}, or {@link Future})
 *
 * @category Types and Interfaces
 */
export type Eventual<T> = Yieldable<T> | Promise<T> | PromiseLike<T>

/**
 * @deprecated Please use {@link Task}, {@link Work}, and/or {@link Checkpoint} instead
 *
 * A cancellable asynchronous operation with automatic resource cleanup.
 *
 * A Job is an asynchronous operation that implements {@link Future} (so it's
 * awaitable, yieldable, and synchronously queryable), with resource cleanup and
 * execution control.
 *
 * Jobs also have {@link Completion.return \.return()} and
 * {@link Completion.throw \.throw()} methods, so you can end a job with a
 * result or error.
 *
 * Most jobs, however, are not intended to produce results, and are merely
 * canceled or restarted (using {@link Cancellable.end \.end()} or
 * {@link Checkpoint.reset \.reset()}).
 *
 * Jobs can be created using {@link start}() and {@link root}.start().
 *
 * @category Types and Interfaces
 * @hidden
 */
export type Job<T=any> = Task<T> & Work<T> & Checkpoint

export interface Future<T> extends Yieldable<T>, Promise<T> {
    /**
     * The result of the future (canceled, returned value, or error), or
     * undefined if there's no result yet.
     *
     * If undefined, this also acts as a reactive value: the calling reactive
     * function or effect (if any) will recalculate when the future settles,
     * with the updated result.
     *
     * @category Obtaining Results
     */
    result(): Result<T> | undefined;
}

/**
 * An ambient execution context, for resource cleanup and error reporting
 *
 * You can add cleanup callbacks to a context via {@link must}() or its
 * .{@link must}() method.  When the context's associated task or checkpoint is
 * ended, canceled, or reset, the callbacks are (synchronously) run in reverse
 * order -- a bit like a delayed and distributed collection of `finally` blocks.
 *
 * @category Types and Interfaces
 */
export interface Context {
    /**
     * Add a cleanup callback to be run when the context is ended or reset.
     * (Non-function values are ignored.)  If the context has already ended, the
     * callback will be invoked asynchronously in the next microtask. Cleanup
     * functions are run in LIFO order, after any {@link Context.release}()
     * callbacks (including those of the context's children), but before any
     * {@link Future} observers are run if the context is a task scope.
     *
     * Generally speaking, this method is used within a task, state, reactive
     * function, or other cleanup context to arrange for used resources to be
     * cleaned up, or to undo other state that was only supposed to be active
     * while the task, state, or effect was active.
     *
     * @category Resource Tracking
     */
    must(cleanup?: OptionalCleanup): this;

    /**
     * Create a mutual-cleanup link with a resource that might be stopped or
     * terminated in some way before the context ends. (Like a child process, a
     * server connection, etc.)
     *
     * If a task uses a lot of such resources, using {@link Context.must}
     * callbacks to trigger each one would result in an ever growing number of
     * callbacks (and uncollectable references to the no-longer-usable
     * resources).  So this method lets you *remove* a cleanup function when
     * it's no longer needed: when the resource is closed or finished, invoking
     * the callback returned by this method will remove the cleanup callback
     * from the context, allowing the resource to be freed before the context
     * cleans up, without accumulating an endless number of callbacks in the
     * context.  (Uneventful also uses this mechanism internally to link child
     * contexts to their parents, so that serially-spawning subtasks don't leak
     * cleanup callbacks.)
     *
     * In order to ensure that all such "child" contexts, resources, and
     * activities are marked as canceled *before* any side effects (such as
     * events, callbacks or I/O operations) can occur, Uneventful prioritizes
     * *all* release callbacks to run before *any* other callbacks of any kind.
     * Since release callbacks are used for child tasks, this means that the
     * entire context subtree is notified immediately of cancellation, before
     * any other actions are taken.  This ensures that no "stray" operations can
     * continue, unaware that their context is cleaning up or ended.
     *
     * This means, however, that release callbacks must do **only** simple
     * actions that **can't** result in arbitrary code being synchronously run.
     * (Some safe examples would be setting flags, cancelling event
     * subscriptions, removing things from internal queues, etc.)  Synchronously
     * triggering events or other callbacks, however, runs the risk of that code
     * doing things it wouldn't have done if it knew its context were canceled.
     *
     * (Note that if you still need such actions to happen, your release callback
     * can always add a new .{@link Context.must}() or .{@link Future.do}()
     * callback at that point, and the callback will then get done during a
     * later phase of cleanup, without losing the benefits of the mutual-cleanup
     * process.)
     *
     * @param cleanup A cleanup callback.  As with `must()`, it will receive a
     * {@link Result}, and its return value is ignored.
     *
     * @returns A callback that should be used to remove the passed-in cleanup
     * callback from the context, if the resource is disposed of before the
     * context cleans up.
     *
     * @category Resource Tracking
     */
    release(cleanup: CleanupFn): DisposeFn;

    /**
     * Start a subtask in the context using the given {@link ActivityFn} or
     * {@link Eventual} value.
     *
     * `ctx.start(activity)` is roughly shorthand for calling
     * ctx.{@link starting}(activity).{@link Work.task task}(), or
     * ctx.{@link starting}().{@link Work.exec exec}(activity).task().  That is,
     * it creates a new {@link Work} of the appropriate type, .exec()s the
     * activity in it, and returns the {@link Task} that will provide the work's
     * result.
     *
     * However, unlike with `.starting()`, if the activity is an
     * Uneventful-supplied {@link Task}, the passed-in task is returned
     * unchanged rather than starting a new task.
     *
     * If the activity is a function and it throws a synchronous error before
     * `.start()` returns, the new task will be canceled and the error rethrown.
     *
     * @template T The type of result the task will eventually produce. Defaults
     * to `never` if not given, meaning that the task will never end itself
     * (except via an error), and will only end when it is canceled or one of
     * its parent contexts ends or resets.
     *
     * @category Execution Control
     */
    start<T=never>(activity: Activity<T>): Task<T>;

    /**
     * @deprecated Use starting() to create a scope, customize it, and then use
     * its .task() or future instead
     * @hidden
     */
    start<T>(): Job<T>

    /**
     * @deprecated `Use .start(boundTo(thisArg, fn)) instead`
     * @hidden
     */
    start<T, This>(thisArg: This, fn: ActivityFn<T, This>): Task<T>;

    /**
     * Subscribe a sink to a stream, starting a task that ends when the stream does
     * (and can be canceled to unsubscribe).
     *
     * This is basically shorthand for `start<void>(work => void src(sink, work,
     * inlet))` -- i.e. a quick way to subscribe to a finite and/or pausable stream.
     *
     * @param src An event source or signal
     * @param sink A callback that will receive the events or values
     * @param inlet Optional - a {@link throttle}() to control backpressure
     * @returns a {@link Task} that can be used to detect the stream end/error, or
     * end()ed to close it early.
     *
     * @category Execution Control
     */
    connect<T>(src: Stream<T>, sink: Sink<T>, inlet?: Throttle | Inlet): Task<void>

    /**
     * Invoke a function in this context, such that calling the global
     * {@link must} function will add cleanup callbacks to it, {@link start}
     * will create child tasks of it, etc.  (Note: signal dependency tracking is
     * disabled for the duration of the call, as if it had been wrapped with
     * {@link peek}().)
     *
     * @remarks Due to TypeScript limitations, only the last overload of `fn`
     * will be used; if you need a specific overload, use `ctx.run(() =>
     * fn(...))` or `ctx.bind(fn)(...)` to get the correct return type and
     * signature checking.)
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     *
     * @category Execution Control
     */
    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Wrap a function to always run in this context.
     *
     * @param fn The function to wrap
     *
     * @returns A function with the same signature/overloads, but which will run
     * in this context when called.  (Note: signal dependency tracking will be
     * disabled for the duration of the call, as if it had been wrapped with
     * {@link peek}().)
     *
     * @remarks Note that if the supplied function has any custom properties,
     * they will *not* be available on the returned function at runtime, even
     * though TypeScript will act as if they are present at compile time.  This
     * is because the only way to copy all overloads of a function signature is
     * to copy the exact type (as TypeScript has no way to generically say,
     * "this is a function with all the same overloads, but none of the
     * properties").
     *
     * @category Execution Control
     */
    bind<F extends (...args: any[]) => any>(fn: F): F
}

/**
 * A cancellable task, scope, checkpoint, cleanup context, etc.
 *
 * @category Types and Interfaces
 */
export interface Cancellable {
    /**
     * Release all resources held by the task or context.
     *
     * Arrange for all cleanup functions and result consumers added to the
     * context (via release, must, do, etc.) be called in the appropriate order.
     * When the call to end() returns, all child tasks will have been notified
     * of their cancellation.  (But not all of their cleanups or result
     * consumers may have run yet, in the event that another task's end() is in
     * progress when this method is called.)
     *
     * If any cleanup callbacks throw exceptions, they're sent to
     * `root.asyncThrow()`, which by default converts them to unhandled promise
     * rejections.  This ensures all of the callbacks will be run, even if one
     * throws an error.  (And none of the errors will be missed.)
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another task, event source, etc.
     *
     * @category Execution Control
     */
    readonly end: () => void;
}

/**
 * An asynchronously-expected result (usually produced by a {@link Task}) that
 * can be awaited or yielded to
 *
 * Futures implement the Promise interface (then, catch, and finally), so they
 * can be passed to Promise-using APIs or awaited by async functions.  They also
 * implement {@link Yieldable}, so you can await their results using `yield *`.
 *
 * In addition to those asynchronous query/callback methods, there is an
 * synchronous query method (.{@link result}()) as well, and some synchronous
 * result callback methods (.{@link do}() and its variants).
 *
 * Synchronous callbacks are run in FIFO order before any asynchronous
 * callbacks, but *after* the producing task's cleanup callbacks have run (if
 * applicable).
 *
 * @category Types and Interfaces
 */
export interface Future<T> extends Yieldable<T>, Promise<T> {
    /**
     * Invoke a callback with the result.
     *
     * Callbacks are executed in FIFO order after any cleanups for the producing
     * task have run, and before any asynchronous (Promise) callbacks run.  You
     * should only use this (and other {@link Future} methods) to obtain a
     * *result*, not to perform cleanups.  (That's what .{@link Context.must}() and
     * .{@link Context.release}() callbacks are for.)
     *
     * @remarks The .{@link onError}(),  .{@link onValue}(), and
     * .{@link onCancel}() methods provide shortcuts for creating `do` callbacks
     * that only run under specific end conditions.
     *
     * @category Obtaining Results
     */
    do(action: (res: Result<T>) => unknown): this;

    /**
     * Invoke a callback upon result if the result is an error.
     *
     * This is shorthand for a .{@link do}() callback that checks for an
     * error and marks it handled, so it uses the same relative order and runs
     * in the same group as other .do callbacks.
     *
     * @param cb A callback that will receive the error
     *
     * @category Obtaining Results
     */
    onError(cb: (err: any) => unknown): this;

    /**
     * Invoke a callback upon result if the result is a success/value.
     *
     * This is shorthand for a .{@link do}() callback that checks for a
     * success/value result, so it uses the same relative order and runs in the
     * same group as other .do callbacks.
     *
     * @param cb A callback that will receive the value
     *
     * @category Obtaining Results
     */
    onValue(cb: (val: T) => unknown): this;

    /**
     * Invoke a callback if the producing task is canceled.
     *
     * This is shorthand for a .{@link do}() callback that checks for a
     * cancellation, so it uses the same relative order and runs in the same
     * group as other .do callbacks.
     *
     * @param cb The callback run on cancellation
     *
     * @category Obtaining Results
     */
    onCancel(cb: () => unknown): this;
}

/**
 * A cancellable and *resettable* context, allowing you to reuse a context
 * multiple times.  (Used for reactive effects and {@link restarting}()
 * functions.)
 *
 * @category Types and Interfaces
 */
export interface Checkpoint extends Scope {
    /**
     * Reset this scope - works just like .{@link Cancellable.end end}(), except
     * that the scope doesn't stay ended, so cleanup callbacks can be added
     * again and won't be invoked until the next reset or the scope ends.
     *
     * Unlinke .{@link Cancellable.end end}(), this method guarantees that *all*
     * cleanups for the scope will have completed running when it returns.
     *
     * @see The {@link restarting}() wrapper can be used to make a function that
     * runs over and over in the same checkpoint, resetting it on each run.
     *
     * @category Execution Control
     */
    reset(): Checkpoint

    /** @hidden @deprecated Please use .{@link Checkpoint.reset reset}() instead */
    restart(): Checkpoint
}

export interface Context {
    /**
     * Report an unhandled error from a child task.
     *
     * If the context has an .{@link Scope.asyncCatch asyncCatch}()
     * handler set, it will be called with the error, otherwise the context/task
     * will end with the supplied error.  If the error then isn't handled by a
     * listener on the associated {@link Future}, the error will cascade to an
     * asyncThrow on the context's parent context, until the {@link root}
     * context and its asyncCatch handler are reached. (Which defaults to
     * creating an unhandled promise rejection.)
     *
     * Note: application code should not normally need to call this method
     * directly, as it's automatically invoked on a task's parent if the task
     * fails and has no error listeners.  (That is, if a task's future isn't
     * awaited by anything, listened to by anything, and has no onError
     * handlers, and the task throw()s, then the error is automatically
     * asyncThrow()n to the task's parent context.)
     *
     * @param err The error thrown by the child task
     *
     * @category Handling Errors
     */
    asyncThrow(err: any): this;
}


/**
 * A cancellable cleanup context with configurable error-reporting scope
 *
 * @category Types and Interfaces
 */
export interface Scope extends Cancellable, Context {
    /**
     * Set up a callback to receive unhandled errors from subtasks.
     *
     * Setting an async-catch handler allows you to create robust parent tasks
     * that log or report errors and restart either a single task or an entire
     * group of them, in the event a subtask malfunctions in a way that's not
     * caught elsewhere.
     *
     * @param handler Either an error-receiving callback, or null.  If null,
     * asyncThrow()n will "crash" the scope (i.e. throw() if it's a task) and
     * possibly be forwarded up to parent scopes as another asyncThrow(). If a
     * callback is given, it's called with `this` bound to the relevant context
     * instance when the scope asyncThrow()s.
     *
     * @category Handling Errors
     */
    asyncCatch(handler: ((this: Context, err: any) => unknown) | null): this;
}

/**
 * Interface for completing a {@link Future} or {@link Task} with a return value
 * or error.
 *
 * @category Types and Interfaces
 */
export interface Completion<T> {
    /**
     * End the task/future with a thrown error, passing an {@link ErrorResult}
     * to cleanup callbacks and listeners.  (Throws an error if the task is
     * already ended or is currently cleaning up.)  Provides the same execution
     * and ordering guarantees as .{@link Cancellable.end end}().
     *
     * Note: since this immediately ends the task with an error, it should only
     * be called by when the work of the task as a whole is no longer able to
     * continue.  If you want to notify a task about an error in a *different*
     * task, you may want to use .{@link Context.asyncThrow asyncThrow}()
     * instead.
     *
     * @category Producing Results
     */
    throw(err: any): this;

    /**
     * End the task/future with a return value, passing a {@link ValueResult} to
     * cleanup callbacks and listeners.  (Throws an error if the task is already
     * ended or is currently cleaning up.)  Provides the same execution and
     * ordering guarantees as .{@link Cancellable.end end}().
     *
     * @category Producing Results
     */
    return(val: T) : this;
}

/**
 * A Work context is a task's {@link Scope} and {@link Completion}: the
 * interface used to .{@link exec}() the task's activities, register cleanups,
 * capture async errors, and determine the task's final {@link Result}.
 *
 * A task's Work is part of its internal implementation, so it's not accessible
 * via the {@link Task} interface.  You can, however, obtain the .{@link task}()
 * of the Work, so that after configuration you can pass the resulting task off
 * to consumers that don't need the task's internals.
 *
 * @template T The type of result the associated task will return.
 *
 * @category Types and Interfaces
 */
export interface Work<T=void> extends Scope, Completion<T> {
    /**
     * Start an independent activity that can complete the task
     *
     * If this is called multiple times on the same work context, the first
     * activity to complete the task "wins", and all activities are then
     * canceled as the work's scope is cleaned up.
     *
     * Note: this method is a **silent no-op** if the task is already completed
     * or canceled, since anything done would just be rolled back by the next
     * microtask anyway.  (If you need to force some side-effect to always run
     * even if the task is over, just run the activity in a different task, e.g.
     * by using `work.exec(work.start(acvitity))`.)
     *
     * @category Producing Results
     */
    exec(activity: Activity<T>): this;

    /**
     * Return the {@link Task} this Work context implements.
     *
     * @category Producing Results
     */
    task(): Task<T>

    /**
     * Return the {@link Future} this Work context implements. (Like
     * .{@link task}(), but without the cancellability).
     *
     * @category Producing Results
     */
    future(): Future<T>
}

/**
 * A thread of parallel, asynchronous execution within the {@link Work} of a
 * {@link Task}
 *
 * An activity is any of:
 *
 * 1) An {@link Eventual} value (like a Promise, {@link Future}, Task,
 *    {@link Coroutine}, etc.) whose result will become the task's result,
 * 2) A function that {@link EventuallyReturns} a value that will become the
 *    task's result, or
 * 3) A {@link Setup} function that creates event listeners, reactive effects,
 *    etc., that do the work of the task (and may optionally mark the work
 *    completed via the work's .{@link Completion.return return}() or
 *    .{@link Completion.throw throw}()) methods.
 *
 * Activities are used as parameters to the {@link start}() and
 * {@link starting}() functions (and {@link Context} methods of the same names),
 * as well as the .{@link Work.exec exec}() method of {@link Work} contexts.
 *
 * Multiple activities can run in the same Task context if they are the same
 * type, or are of type `never`.  The first one to produce a result or cause the
 * task to end with an error will deterine the task's final result, and all the
 * task's activities will be canceled/cleaned up.
 *
 * @template T The type of result the activity will produce.  A type of `never`
 * means the activity never produces a value, but instead will run until the task
 * is cleaned up, e.g. due to being canceled, ended with an error, etc.
 *
 * @category Types and Interfaces
 */
export type Activity<T=void> = Eventual<T> | EventuallyReturns<T> | Setup<T>

/**
 * A task is a cancellable future: i.e. something that produces an async result,
 * but whose work can be aborted.
 *
 * @template T The type of result the task will produce.  A type of `never`
 * means the activity never produces a value, but instead will run until it is
 * is cleaned up, e.g. due to being canceled, ended with an error, etc.
 *
 * @category Types and Interfaces
 */
export interface Task<T=void> extends Cancellable, Future<T> {}

export interface Context {
    /**
     * Create the {@link Work} of a new task, optionally starting activities in
     * it
     *
     * `.starting(a1, a2, ...)` is roughly equivalent to `.start(work =>
     * work.exec(a1).exec(a2)...)`, except that the `work` is returned instead
     * of the task.
     *
     * @param activities Zero or more activities for the new task's {@link Work}
     * to .{@link Work.exec exec}().  The first one to complete the task (via
     * return/throw) will determine the overall task result; all others will be
     * canceled.
     *
     * If any of the startables synchronously completes (or throws a synchronous
     * error) during the initial setup, the remaining startables will not be
     * run.  As with .{@link Context.start start}(), a synchronous error also
     * cancels the partially-initialized task.
     *
     * @returns A {@link Work} context you can customize to set up its
     * .{@link Work.future task}() or .{@link Work.future future}() with.
     *
     * @category Execution Control
     */
    starting<T=void>(...activities: Activity<T>[]): Work<T>

    /**
     * Returns true if the context is cleaning up due to completion,
     * cancellation, or checkpoint .{@link Checkpoint.reset reset}().
     *
     * Cleanups added to the context while it is being cleaned up will be run
     * later, after the caller returns (possibly in a different microtask).  A
     * context ended by return, throw, or cancellation will remain in a
     * perpetual state of cleaning up, but a checkpoint that is
     * .{@link Checkpoint.reset reset}() will go back to returning false from
     * this method once the reset completes.
     *
     * @category Resource Tracking
     */
    cleaningUp(): boolean

    /**
     * Create a checkpoint as a child context
     *
     * (The new context will *not* automaticaly end when the parent does, but
     * unhandled async errors will propagate to the parent if you don't give it
     * an explicit asyncCatch handler.)
     *
     * @category Resource Tracking
     */
    checkpoint(): Checkpoint
}

/**
 * A pausable computation that ultimately produces a value of type T.
 *
 * An item of this type can be used to create a task or activity of type T, or
 * awaited in a {@link Coroutine} via `yield *` to obtain the value.
 *
 * Any generator function that yields Suspend values and ultimately returns a
 * value, implicitly returns a Yieldable Coroutine of that type, but it's best
 * to *explicitly* declare this so that TypeScript can properly typecheck your
 * yield expressions.  (e.g. `function *(): Coroutine<number> {}` for a
 * generator function that ultimately returns a number.)
 *
 * @remarks
 * This interface is actually a subset of {@link Coroutine}, so coroutines are
 * always Yieldables.
 *
 *
 * @yields {@link Suspend}\<any>
 * @returns T
 *
 * @category Types and Interfaces
 */
export type Yieldable<T> = {
    /**
     * An iterable suitable for use with `yield *` (in a coroutine)
     * to obtain a result.
     *
     * @category Obtaining Results
     */
    [Symbol.iterator](): Coroutine<T>
}

/**
 * A generator yielding {@link Suspend} callbacks
 *
 * Generator functions implementing this type should only ever `yield *` to
 * things that are of {@link Yieldable} type, such as a {@link Task},
 * {@link to}() or other generators declared Yieldable.  (They can also yield
 * {@link Suspend} values, of course.)
 *
 * Coroutines run asynchronously, beginning in the microtask *after* they are
 * .{@link Work.exec exec}()'d or started.  Any result they return or error they
 * throw will be treated as the result of the task they run in.  If the task is
 * canceled (or completed via another activity), the coroutine will be aborted,
 * running any finally clauses up to their first `yield` operation, and then
 * jumping to the next outer finally clause, until all such clauses have had a
 * chance to run.  Any return value of an aborted coroutine is ignored; any
 * error is forwarded to a parent scope via {@link Context.asyncThrow}().  If
 * the coroutine uses `using` statements, these are also cleaned up during
 * cancellation.
 *
 * @category Types and Interfaces
 */
export type Coroutine<T> = Generator<Suspend<unknown>, T, any>

/**
 * An asynchronous operation that can be waited on by a {@link Coroutine}.
 *
 * When a {@link Coroutine} yields a Suspend function, it is called with a
 * {@link Request}.  The Suspend function should arrange for the request to be
 * settled (via {@link resolve} or {@link reject}).
 *
 * Note: If the request is not settled, **the coroutine will be suspended until
 * cancelled by outside forces**.  (Such as its enclosing context cleaning up,
 * or explicit throw()/return() calls on the task's {@link Work}, or the
 * completion of another activity sharing the task's work context via
 * {@link Context.starting starting}() or {@link Work.exec exec}().)
 *
 * Also note that any subtasks the Suspend function creates (or cleanup
 * callbacks it registers) **will not be cleaned up until the *calling* task
 * ends**.  So any resources that won't be needed once the task is resumed
 * should be explicitly disposed of -- in which case you should probably just
 * `yield *` to a {@link start}(), instead of yielding a Suspend!
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
 * Settling a request will cause the requesting activity (or other code) to
 * resume immediately, running up to its next suspension or termination.
 * (Unless it's settled while the requesting activity is already on the call
 * stack, in which case the activity will be resumed later.)
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
 * unsubscribe when its calling context is cleaned up.  Once subscribed, it
 * should invoke the callback to trigger recalculation of the signal(s) that
 * were targeted via {@link recalcWhen}.
 *
 * @category Types and Interfaces
 */
export type RecalcSource = ((cb: ()=>void) => unknown);

/** @hidden @deprecated Use {@link EventuallyReturns} instead */
export type AsyncStart<T, This=void> = EventuallyReturns<T, This>

/** @hidden @deprecated Use {@link Setup} instead. */
export type SyncStart<T, This=void>  = Setup<T, This>;


/** @hidden @deprecated Use {@link Coroutine} instead  */
export type JobIterator<T> = Coroutine<T>

/** @hidden @deprecated Please use {@link Yieldable} instead */
export type Yielding<T> = Yieldable<T>

/** @hidden @deprecated Please use {@link Eventual} instead */
export type StartObj<T> = Eventual<T>

/** @hidden @deprecated Please use {@link ActivityFn} instead */
export type StartFn<T, This=void> = ActivityFn<T,This>
