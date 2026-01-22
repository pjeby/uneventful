import { currentCell, currentJob, popCtx, pushCtx } from "./ambient.ts";
import { getJob, makeJob } from "./tracking.ts";
import { AnyFunction, CleanupFn, Job, OptionalCleanup, StartFn, StartObj, Yielding } from "./types.ts";
import { apply } from "./utils.ts";

/**
 * Add a cleanup function to the active job. Non-function values are ignored.
 * Equivalent to calling .{@link Job.must must}() on the current job.  (See
 * {@link Job.must}() for more details.)
 *
 * @category Jobs
 */
export function must(cleanup?: OptionalCleanup): void {
    getJob().must(cleanup);
}

/**
 * Start a nested job within the currently-active job.  (Shorthand for
 * calling .{@link Job.start start}(...) on the active job.)
 *
 * This function can be called with zero, one, or two arguments:
 *
 * - When called with zero arguments, the new job is returned without any other
 *   initialization.
 *
 * - When called with one argument that's a function (either a {@link SyncStart}
 *   or {@link AsyncStart}): the function is run inside the new job and receives
 *   it as an argument.  It can return a {@link Yielding} iterator (such as a
 *   generator or job), a promise, or void.  A returned iterator or promise will
 *   be treated as if the method was called with that to begin with; a returned
 *   job will be awaited and its result transferred to the new job
 *   asynchronously.  A returned function will be added to the job via `must()`.
 *
 * - When called with one argument that's a {@link Yielding} iterator (such as a
 *   generator or an existing job): it's attached to the new job and executed
 *   asynchronously. (Starting in the next available microtask.)
 *
 * - When called with one argument that's a Promise, it's converted to a job
 *   that will end when the promise settles.  The resulting job is returned.
 *
 * - When called with two arguments -- a "this" object and a function -- it
 *   works the same as one argument that's a function, except the function is
 *   bound to the supplied "this" before being called.
 *
 *   This last signature is needed because you can't make generator arrows in JS
 *   yet: if you want to start() a generator function bound to the current
 *   `this`, you'll want to use `.start(this, function*() { ...whatever  })`.
 *
 *   (Note, however, that TypeScript and/or VSCode may require that you give
 *   such a function an explicit `this` parameter (e.g. `.start(this, function
 *   *(this) {...}));`) in order to correctly infer types inside a generator
 *   function.)
 *
 * In any of the above cases, if a supplied function throws an error while
 * starting, the new job will be ended, and the error synchronously re-thrown.
 *
 * @returns the created {@link Job}
 *
 * @category Jobs
 */
export function start<T>(init?: StartFn<T> | StartObj<T>): Job<T>;

/**
 * The two-argument variant of start() allows you to pass a "this" object that
 * will be bound to the initialization function.  (It's mostly useful for
 * generator functions, since generator arrows aren't a thing yet.)
 */
export function start<T, This>(thisArg: This, fn: StartFn<T, This>): Job<T>;
export function start<T, This>(init: StartFn<T>|StartObj<T>|This, fn?: StartFn<T, This>) {
    return getJob().start(init as This, fn);
}

/**
 * Is there a currently active job? (i.e., can you safely use {@link must}(),
 * or {@link getJob}() right now?)
 *
 * @category Jobs
 */
export function isJobActive() { return !!(currentJob || currentCell?.isObserved()); }


const timers = new WeakMap<Job,
    ReturnType<typeof setTimeout> |  // current timeout
    undefined | // no timeout set since job was last restarted (if ever)
    null  // current timeout is 0, aka explicit no-timeout
>();

/**
 * Set the cancellation timeout for a job.
 *
 * When the timeout is reached, the job is canceled (throwing
 * {@link CancelError} to any waiting promises or jobs), unless a new timeout
 * is set before then.  You may set a new timeout value for a job as many times
 * as desired.  A timeout value of zero disables the timeout. Timers are
 * disposed of if the job is canceled or restarted.
 *
 * @param ms Optional: Number of milliseconds after which the job will be
 * canceled. Defaults to zero if not given.
 *
 * @param job Optional: the job to apply the timeout to.  If none is given, the
 * active job is used.
 *
 * @returns the job to which the timeout was added or removed.
 *
 * @category Scheduling
 */
export function timeout<T>(ms: number, job?: Job<T>): Job<T>;
export function timeout(ms = 0, job: Job = getJob()) {
    let timer = timers.get(job);
    if (timer) {
        clearTimeout(timer);
    } else if (timer === undefined && !job.result()) {
        // no timeout has been set since job was last restarted,
        // so we need to arrange to clear it
        job.must(timeout.bind(null, 0, job));
    }
    if (job.result()) {
        // allow restarted timer to set a new must()
        timers.delete(job);
    } else if (ms) {
        timers.set(job, setTimeout(() => { timers.set(job, null); job.end(); }, ms));
    } else {
        timers.set(job, null); // Zero = cancel timeout, but don't duplicate must() if called again
    }
    return job;
}

const abortSignals = new WeakMap<Job, AbortSignal>();

/**
 * Get an AbortSignal that aborts when the job ends or is restarted.
 *
 * @param job Optional: the job to get an AbortSignal for.  If none is given,
 * the active job is used.
 *
 * @returns the AbortSignal
 *
 * @category Jobs
 */
export function abortSignal(job: Job = getJob()) {
    let signal = abortSignals.get(job);
    if (!signal) {
        const ctrl = new AbortController;
        signal = ctrl.signal;
        job.must(() => { abortSignals.set(job, null); ctrl.abort(); });
        abortSignals.set(job, signal);
        if (job.result()) ctrl.abort();
    }
    return signal;
}

/**
 * Wrap a function in a {@link Job} that restarts each time the resulting
 * function is called, thereby canceling any nested jobs and cleaning up any
 * resources used by previous calls. (This can be useful for such things as
 * canceling an in-progress search when the user types more text in a field.)
 *
 * The restarting job will be ended when the job that invoked `restarting()`
 * is finished, canceled, or restarted.  Calling the wrapped function after its
 * job has ended will result in an error.  You can wrap any function any number
 * of times: each call to `restarting()` creates a new, distinct "restarting
 * job" and function wrapper to go with it.
 *
 * @param task (Optional) The function to be wrapped. This can be any function:
 * the returned wrapper function will match its call signature exactly, including
 * overloads.  (So for example you could wrap the {@link start} API via
 * `restarting(start)`, to create a function you can pass job-start functions to.
 * When called, the function would cancel any outstanding job from a previous
 * call, and start the new one in its place.)
 *
 * @returns A function of identical type to the input function.  If no input
 * function was given, the returned function will just take one argument (a
 * zero-argument function optionally returning a {@link CleanupFn}).
 *
 * @category Jobs
 */
export function restarting<F extends AnyFunction>(task: F): F
export function restarting(): (task: () => OptionalCleanup) => void
export function restarting<F extends AnyFunction>(task?: F): F {
    const outer = getJob(), inner = makeJob<never>(outer), {end} = inner;
    task ||= <F>((f: () => OptionalCleanup) => { inner.must(f()); });
    inner.asyncCatch(e => outer.asyncThrow(e));
    return <F>function(this: ThisParameterType<F>) {
        inner.restart().must(outer.release(end));
        pushCtx(inner);
        try { return apply(task, this, arguments); }
        catch(e) { inner.restart(); throw e; }
        finally { popCtx(); }
    };
}

/**
 * Wrap an argument-taking function so it will run in (and returns) a new Job
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
 *     *someMethod(arg1): Yielding<SomeResultType> {
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
 * return a {@link Job}, TypeScript will only see it as a {@link Yielding}.
 *
 * This is fine if all you're going to do is `yield *` it to wait for the
 * result, but if you need to use any job-specific methods on it, you'll have to
 * pass it through {@link start} to have TypeScript treat it as an actual job.
 * (Luckily, start() has a fast path to return the original job if it's passed a
 * job, so you won't actually create a new job by doing this.)
 *
 * @param fn The function to wrap. A function returning a generator or
 * promise-like object (i.e., a {@link StartObj}).
 *
 * @returns A wrapped version of the function that passes through its arguments
 * to the original function, while running it in a new job.  (The wrapper also
 * returns the job.)
 *
 * @category Jobs
 */
export function task<T, A extends any[], C>(fn: (this: C, ...args: A) => StartObj<T>): (this: C, ...args: A) => Job<T>;

/** @hidden TC39 Decorator protocol */
export function task<T, A extends any[], C>(
    fn: (this: C, ...args: A) => StartObj<T>, ctx: {kind: "method"}
): (this: C, ...args: A) => Job<T>;

/** @hidden Legacy Decorator protocol */
export function task<T, A extends any[], C, D extends {value?: (this:C, ...args: A) => StartObj<T>}>(
    clsOrProto: any, name: string|symbol, desc: D
): D

export function task<T, A extends any[], C, D extends {value?: (this:C, ...args: A) => StartObj<T>}>(
    fn: (this: C, ...args: A) => StartObj<T>, _ctx?: any, desc?: D
): D | ((this: C, ...args: A) => Job<T>) {
    if (desc) return {...desc, value: task(desc.value)};
    return function (this: C, ...args: A) {
        return start(() => apply(fn, this, args));
    }
}
