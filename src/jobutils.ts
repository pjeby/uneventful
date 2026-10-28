import { currentCell, currentCtx, popCtx, pushCtx } from "./ambient.ts";
import { sleep } from "./async.ts";
import { CancelError } from "./results.ts";
import { currentContext } from "./tracking.ts";
import {
    AnyFunction, CleanupFn, Job, OptionalCleanup, Context, ActivityFn, Eventual, Task, Yieldable, Scope, Coroutine,
    Work, Activity
} from "./types.ts";
import { apply, boundTo } from "./utils.ts";

/**
 * Add a cleanup function to the active context. Non-function values are ignored.
 * Equivalent to calling .{@link Context.must must}() on the current contet.  (See
 * {@link Context.must}() for more details.)
 *
 * @category Tasks and Context
 */
export function must(cleanup?: OptionalCleanup): void {
    currentContext().must(cleanup);
}

/**
 * Start a new task from an activity, as a child of the {@link currentContext}()
 *
 * `start(activity)` is roughly shorthand for calling
 * {@link starting}(activity).{@link Work.task task}(), or
 * {@link starting}().{@link Work.exec exec}(activity).task().  That is, it
 * creates a new {@link Work} of the appropriate type, .exec()s the activity in
 * it, and returns the {@link Task} that will provide the work's result.
 *
 * However, unlike with `starting()`, if the activity is an Uneventful-supplied
 * {@link Task}, the passed-in task is returned unchanged rather than starting a
 * new task.
 *
 * If the activity is a function and it throws a synchronous error before
 * `start()` returns, the new task will be canceled and the error rethrown.
 *
 * @template T The type of result the task will eventually produce. Defaults
 * to `never` if not given, meaning that the task will never end itself
 * (except via an error), and will only end when it is canceled or one of
 * its parent contexts ends or resets.
 *
 * @category Tasks and Context
 */
export function start<T=never>(activity: Activity<T>): Task<T>;

/**
 * @hidden @deprecated Use {@link starting}() to create a {@link Work} context,
 * then customize it and use its .task() or .future() instead
 */
export function start<T>(): Job<T>;

/**
 * @hidden @deprecated Use `start(`{@link boundTo}`(thisArg, fn)`)
 */
export function start<T, This>(thisArg: This, fn: ActivityFn<T, This>): Task<T>;

export function start<T, This>(activity?: Activity<T>|This, fn?: ActivityFn<T, This>) {
    return currentContext().start(activity as This, fn!);
}

/**
 * Create the {@link Work} of a new task, optionally starting activities in it
 *
 * `starting(a1, a2, ...)` is roughly equivalent to `start(work =>
 * work.exec(a1).exec(a2)...)`, except that the `work` is returned instead of
 * the task.
 *
 * @param activities Zero or more activities for the new task's {@link Work} to
 * .{@link Work.exec exec}().  The first one to complete the task (via
 * return/throw) will determine the overall task result; all others will be
 * canceled.
 *
 * If any of the startables synchronously completes (or throws a synchronous
 * error) during the initial setup, the remaining startables will not be run. As
 * with {@link start}(), a synchronous error also cancels the
 * partially-initialized task.
 *
 * @returns A {@link Work} context you can customize to set up its
 * .{@link Work.future task}() or .{@link Work.future future}() with.
 *
 * @category Tasks and Context
 */
export function starting<T=never>(...activities: Activity<T>[]): Work<T> {
    return currentContext().starting(...activities)
}

/**
 * Is there a current context? (i.e., can you safely use
 * {@link currentContext}() or APIs that use it right now?)
 *
 * @category Tasks and Context
 */
export function inContext() { return !!(currentCtx || (currentCell && currentCell.isObserved())) }


const timers = new WeakMap<Context,
    ReturnType<typeof setTimeout> |  // current timeout
    undefined | // no timeout set since job was last restarted (if ever)
    null  // current timeout is 0, aka explicit no-timeout
>();

/**
 * @deprecated Use {@link timeoutAfter}() or {@link watchdog}() instead!
 *
 * Set a cancellation timeout for a context
 *
 * When the timeout is reached, the context is canceled (throwing
 * {@link CancelError} to its parent context(s), unless a new timeout
 * is set before then.  You may set a new timeout value for a context as many times
 * as desired.  A timeout value of zero disables the timeout. Timers are
 * disposed of if the context is canceled or reset.
 *
 * @param ms Optional: Number of milliseconds after which the job will be
 * canceled. Defaults to zero (remove the timeout) if not given.
 *
 * @param scope Optional: the scope to apply the timeout to.  If none is given,
 * the ambient context's scope is used.
 *
 * @returns the job to which the timeout was added or removed.
 *
 * @category Scheduling
 * @hidden
 */

export function timeout<T>(ms: number, scope?: Scope): Scope;
export function timeout(ms = 0, scope: Scope = currentContext() as Scope) {
    let timer = timers.get(scope);
    if (timer) {
        clearTimeout(timer);
    } else if (timer === undefined && !scope.cleaningUp()) {
        // no timeout has been set since job was last restarted,
        // so we need to arrange to clear it
        scope.must(timeout.bind(null, 0, scope));
    }
    if (scope.cleaningUp()) {
        // allow restarted timer to set a new must()
        timers.delete(scope);
    } else if (ms) {
        timers.set(scope, setTimeout(() => { timers.set(scope, null); scope.end(); }, ms));
    } else {
        timers.set(scope, null); // Zero = cancel timeout, but don't duplicate must() if called again
    }
    return scope;
}

/**
 * A timeout error - thrown by {@link watchdog}() and {@link timeoutAfter}()
 *
 * @category Errors
 */
export class TimeoutError extends Error {}

/**
 * Create an activity that throws a {@link TimeoutError} once a timeout is
 * reached
 *
 * e.g. `starting(someStartable, timeoutAfter(2000, "whoops!")).task()` will
 * create a task that terminates with a `new TimeoutError("whoops!")` if
 * `someStartable` doesn't complete in under 2 seconds.
 *
 * Or, to asyncThrow from inside a task, just `start(timeoutAfter(...))` in the
 * task's body, or `work.exec(timeoutAfter(...))`. (If you need a resettable
 * deadline, use {@link watchdog}() instead.)
 *
 * @category Scheduling
 */
export function timeoutAfter(ms: number, message="Timeout reached"): () => Coroutine<never> {
    return function*() {
        yield *sleep(ms)
        throw new TimeoutError(message)
    }
}

/**
 * Create a resettable watchdog timer for the current context, that will
 * asyncThrow if it ever times out.
 *
 * So e.g. `const deadline = watchdog(); deadline(5000, "Time's up!");` will set
 * up a 5 second timeout (with the error message "Time's up"), and you can then
 * call `deadline()` as many times as you like to start or reset the timer.
 *
 * @returns A function you can call zero or more times with a number of
 * milliseconds to reset the timer to.  Passing zero cancels the timeout, and a
 * non-zero value starts it over with the new duration.
 *
 * @category Scheduling
 */
export function watchdog() {
    return restarting((ms: number, message?: string) => { ms && start(timeoutAfter(ms, message)) })
}

const abortSignals = new WeakMap<Context, AbortSignal|null>();

/**
 * Get an AbortSignal that aborts when the context ends or is cleaned up.
 *
 * @param context Optional: the context to get an AbortSignal for.  If none is given,
 * the current context is used.
 *
 * @returns the AbortSignal
 *
 * @category Tasks and Context
 */
export function abortSignal(context = currentContext()) {
    let signal = abortSignals.get(context);
    if (!signal) {
        const ctrl = new AbortController;
        signal = ctrl.signal;
        context.must(() => { abortSignals.set(context, null); ctrl.abort(); });
        abortSignals.set(context, signal);
        if (context.cleaningUp()) ctrl.abort();
    }
    return signal;
}

/**
 * Wrap a function in a {@link Checkpoint} that resets each time the resulting
 * function is called, thereby canceling any in-progress subtasks and cleaning
 * up any resources used by previous calls. (This can be useful for such things
 * as canceling an in-progress search when the user types more text in a field.)
 *
 * The checkpoint will be ended when the context that invoked `restarting()` is
 * finished, canceled, or reset.  Calling the wrapped function after its
 * checkpoint has ended will result in an error.  You can wrap any function any
 * number of times: each call to `restarting()` creates a new, distinct
 * checkpoint and function wrapper to go with it.
 *
 * @param action (Optional) The function to be wrapped. This can be any
 * function: the returned wrapper function will match its call signature
 * exactly, including overloads.  (So for example you could wrap the
 * {@link start} API via `restarting(start)`, to create a function you can pass
 * {@link ActivityFn} functions to. When called, the function would cancel any
 * outstanding task from a previous call, and start the new one in its place.)
 *
 * @returns A function of identical type to the input function.  If no input
 * function was given, the returned function will just take one argument (a
 * zero-argument function optionally returning a {@link CleanupFn}), and will
 * run it in the checkpoint's context.
 *
 * @category Tasks and Context
 */
export function restarting<F extends AnyFunction>(action: F): F
export function restarting(): (action: () => OptionalCleanup) => void
export function restarting<F extends AnyFunction>(action?: F): F {
    const outer = currentContext(), inner = outer.checkpoint(), {end} = inner;
    action ||= <F>((f: () => OptionalCleanup) => { inner.must(f()); });
    inner.asyncCatch(e => outer.asyncThrow(e));
    return <F>function(this: ThisParameterType<F>) {
        inner.reset().must(outer.release(end));
        pushCtx(inner);
        try { return apply(action, this, arguments); }
        catch(e) { inner.reset(); throw e; }
        finally { popCtx(); }
    };
}

/**
 * Wrap an argument-taking function so it will run in (and returns) a new {@link Task}
 * when called.
 *
 * This lets you avoid the common pattern of needing to write your functions or
 * methods like this:
 *
 * ```ts
 * function outer(arg1, arg2) {
 *     return start(function*() {
 *         // ...
 *     })
 * }
 * ```
 * and instead write them like this:
 * ```ts
 * const outer = task(function *(arg1, arg2) {
 *     // ...
 * });
 * ```
 * or this:
 * ```ts
 * class Something {
 *     ⁣⁣@task  // auto-detects TC39 or legacy decorators
 *     *someMethod(arg1): Coroutine<SomeResultType> {
 *         // ...
 *     }
 * }
 * ```
 *
 * Important: if the wrapped function or method has overloads, the resulting
 * function type will be based on the **last** overload, because TypeScript (at
 * least as of 5.x) is still not very good at dealing with higher order
 * generics, especially if overloads are involved.
 *
 * Also note that TypeScript doesn't allow decorators to change the calling
 * signature or return type of a method, so even though the above method will
 * return a {@link Task}, TypeScript will only see it as a {@link Coroutine}.
 *
 * This is fine if all you're going to do is `yield *` it to wait for the
 * result, but if you need to use any task-specific methods on it, you'll have
 * to pass it through {@link start} to have TypeScript treat it as an actual
 * Task. (Luckily, start() has a fast path to return the original task if it's
 * passed a task, so you won't actually create a new task by doing this.)
 *
 * @param fn The function to wrap. A function returning a {@link Coroutine},
 * {@link Yieldable}, or promise-like object (i.e., an {@link Eventual}).
 *
 * @returns A wrapped version of the function that passes through its arguments
 * to the original function, while running it in a new task.  (The wrapper also
 * returns the task.)
 *
 * @category Tasks and Context
 */
export function task<T, A extends any[], C>(fn: (this: C, ...args: A) => Eventual<T>): (this: C, ...args: A) => Task<T>;

/** @hidden TC39 Decorator protocol */
export function task<T, A extends any[], C>(
    fn: (this: C, ...args: A) => Eventual<T>, ctx: {kind: "method"}
): (this: C, ...args: A) => Task<T>;

/** @hidden Legacy Decorator protocol */
export function task<T, A extends any[], C, D extends {value?: (this:C, ...args: A) => Eventual<T>}>(
    clsOrProto: any, name: string|symbol, desc: D
): D

export function task<T, A extends any[], C, D extends {value: (this:C, ...args: A) => Eventual<T>}>(
    fn: (this: C, ...args: A) => Eventual<T>, _ctx?: any, desc?: D
): D | ((this: C, ...args: A) => Task<T>) {
    if (desc) return {...desc, value: task(desc.value)};
    return function (this: C, ...args: A) {
        return start(() => apply(fn, this, args));
    }
}
