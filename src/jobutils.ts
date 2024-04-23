import { ExtType, MaybeHas, extension } from "./ext.ts";
import { Job, getJob } from "./tracking.ts";

type TimeoutExt = ExtType<
    "uneventful/timeout",
    ReturnType<typeof setTimeout> |  // current timeout
    undefined | // no timeout set since job was last restarted (if ever)
    null  // current timeout is 0, aka explicit no-timeout
>;
const {get: getTimer, set: setTimer} = extension<TimeoutExt>("uneventful/timeout");

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
export function timeout(ms = 0, job: Job & MaybeHas<TimeoutExt> = getJob()) {
    let timer = getTimer(job);
    if (timer) {
        clearTimeout(timer);
    } else if (timer === undefined && !job.result()) {
        // no timeout has been set since job was last restarted,
        // so we need to arrange to clear it
        job.must(timeout.bind(null, 0, job));
    }
    setTimer(job,
        job.result() ?
            undefined :  // allow restarted timer to set a new must()
            (ms ?
                setTimeout(() => { setTimer(job, null); job.end(); }, ms) :
                null  //   cancel timeout, but don't duplicate must() if called again
            )
    );
    return job;
}

type AbortExt = ExtType<"uneventful/abortSignal",  AbortSignal>;
const {get: getSignal, set: setSignal} = extension<AbortExt>("uneventful/abortSignal");

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
export function abortSignal(job: Job & MaybeHas<AbortExt> = getJob()) {
    let signal = getSignal(job);
    if (!signal) {
        const ctrl = new AbortController;
        signal = ctrl.signal;
        job.do(() => { setSignal(job, null); ctrl.abort(); });
        setSignal(job, signal);
        if (job.result()) ctrl.abort();
    }
    return signal;
}
