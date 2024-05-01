import { current, freeCtx, makeCtx, swapCtx } from "./ambient.ts";
import { getJob, makeJob } from "./tracking.ts";
import { AnyFunction, Job, OptionalCleanup, Start, Yielding } from "./types.ts";

/**
 * Add a cleanup function to the active job. Non-function values are ignored.
 * Equivalent to {@link getJob}().{@link Job.must must}() -- see
 * {@link Job.must}() for more details.
 *
 * @category Jobs
 */
export function must<T>(cleanup?: OptionalCleanup<T>): Job<T> {
    return (getJob() as Job<T>).must(cleanup);
}

/**
 * Start a nested job within the currently-active job.  (Shorthand for
 * {@link getJob}().{@link Job.start start}(...).)
 *
 * This function can be called with zero, one, or two arguments:
 *
 * - When called with zero arguments, the new job is returned without any other
 *   initialization.
 *
 * - When called with one argument that's a {@link Yielding} iterator (such as a
 *   generator or an existing job): it's attached to the new job and executed
 *   asynchronously. (Starting in the next available microtask.)
 *
 * - When called with one argument that's a function (either a {@link SyncStart}
 *   or {@link AsyncStart}): the function is run inside the new job and
 *   receives it as an argument.  It can return a {@link Yielding} iterator
 *   (such as a generator), a cleanup callback ({@link CleanupFn}), or void.  A
 *   returned Yielding will be treated as if the method was called with that to
 *   begin with; a returned callback will be added to the job as a `must()`.
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
 * In any of the above cases, if a supplied function throws an error, the new
 * job will be ended, and the error re-thrown.
 *
 * @returns the created {@link Job}
 *
 * @category Jobs
 */
export function start<T>(fn?: Start<T>|Yielding<T>): Job<T>;

/**
 * The two-argument variant of start() allows you to pass a "this" object that
 * will be bound to the initialization function.  (It's mostly useful for
 * generator functions, since generator arrows aren't a thing yet.)
 */
export function start<T,C>(ctx: C, fn: Start<T,C>): Job<T>;
export function start<T,C>(fnOrCtx: Start<T>|Yielding<T>|C, fn?: Start<T,C>) {
    return getJob().start(fnOrCtx as C, fn);
}

/**
 * Is there a currently active job? (i.e., can you safely use {@link must}(),
 * or {@link getJob}() right now?)
 *
 * @category Jobs
 */
export function isJobActive() { return !!current.job; }


const timers = new WeakMap<Job,
    ReturnType<typeof setTimeout> |  // current timeout
    undefined | // no timeout set since job was last restarted (if ever)
    null  // current timeout is 0, aka explicit no-timeout
>();

/**
 * Set the cancellation timeout for a job.
 *
 * When the timeout is reached, the job is canceled (throwing
 * {@link CancelResult} to any waiting promises or jobs), unless a new timeout
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
export function timeout<T>(ms: number): Job<unknown>;
export function timeout<T>(ms: number, job: Job<T>): Job<T>;
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
        job.do(() => { abortSignals.set(job, null); ctrl.abort(); });
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
export function restarting(): (task: () => OptionalCleanup<never>) => void
export function restarting<F extends AnyFunction>(task: F): F
export function restarting<F extends AnyFunction>(task?: F): F {
    const outer = getJob(), inner = makeJob<never>(outer), {end} = inner;
    task ||= <F>((f: () => OptionalCleanup<never>) => { inner.must(f()); });
    inner.asyncCatch(e => outer.asyncThrow(e));
    return <F>function(this: any) {
        inner.restart().must(outer.release(end));
        const old = swapCtx(makeCtx(inner));
        try { return task.apply(this, arguments as any); }
        catch(e) { inner.restart(); throw e; }
        finally { freeCtx(swapCtx(old)); }
    };
}
