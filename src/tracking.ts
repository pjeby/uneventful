import { pushCtx, popCtx, currentJob, currentCell, cellJob } from "./ambient.ts";
import { catchers, defaultCatch, owners } from "./internals.ts";
import { CleanupFn, Job, Request, Yielding, Suspend, PlainFunction, StartFn, OptionalCleanup, JobIterator, RecalcSource, StartObj } from "./types.ts";
import { defer } from "./defer.ts";
import { JobResult, ErrorResult, CancelResult, isCancel, ValueResult, isError, isValue, noop, markHandled, isUnhandled, propagateResult } from "./results.ts";
import { rejecter, resolver, getResult, fulfillPromise } from "./results.ts";
import { Chain, chain, isEmpty, pop, push, pushCB, qlen, recycle, unshift } from "./chains.ts";
import { Stream, Sink, Inlet, Connection } from "./streams.ts";
import { GeneratorBase, apply } from "./utils.ts";
import { isFunction } from "./utils.ts";

/**
 * Return the currently-active Job, or throw an error if none is active.
 *
 * (You can check if a job is active first using {@link isJobActive}().)
 *
 * @category Jobs
 */
export function getJob<T=unknown>() {
    const job = currentJob || cellJob();
    if (job) return job as Job<T>;
    throw new Error("No job is currently active");
}

/** RecalcSource factory for jobs (so you can wait on a job result in a signal or rule) */
function recalcJob(job: Job<any>): RecalcSource { return (cb => { currentJob.must(job.release(cb)); }); }

function runChain<T>(res: JobResult<T>, cbs: Chain<CleanupFn<T>>): undefined {
    let cb: CleanupFn<T>;
    while (cb = pop(cbs)) try { cb(res); } catch (e) { root.asyncThrow(e); }
    cbs && recycle(cbs);
    return undefined;
}

// The set of jobs whose callbacks need running during an end() sweep
var inProcess = new Set<_Job<any>>;

export class _Job<T> implements Job<T> {

    do(cleanup: CleanupFn<T>): this {
        unshift(this._chain(), cleanup);
        return this;
    }

    onError(cb: (err: any) => unknown): this {
        return this.do(r => { if (isError(r)) cb(markHandled(r)); });
    }

    onValue(cb: (val: T) => unknown): this {
        return this.do(r => { if (isValue(r)) cb(r.val); });
    }

    onCancel(cb: () => unknown): this {
        return this.do(r => { if (isCancel(r)) cb(); });
    }

    result(): JobResult<T> | undefined {
        // If we're done, we're done; otherwise make signals/rules reading this
        // recalc when we're done (handy for rendering "loading" states).
        return this._done || currentCell?.recalcWhen(this, recalcJob) || undefined;
    }

    get [Symbol.toStringTag]() { return "Job"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs;
        // if we have an unhandled error, fall through to queued mode for later
        // re-throw; otherwise, if there aren't any callbacks we're done here
        if (!cbs && !isUnhandled(res)) return;

        const ct = inProcess.size; pushCtx();
        // Put a placeholder on the queue if it's empty
        if (!ct) inProcess.add(null);

        // Give priority to the release() chain so we get breadth-first flagging
        // of all child jobs as canceled immediately
        if (cbs && cbs.u) cbs.u = runChain(res, cbs.u);

        // Put ourselves on the queue *after* our children, so their cleanups run first
        inProcess.add(this);

        // if the queue wasn't empty, there's a loop above us that will run our must/do()s
        if (ct) { popCtx(); return; }

        // don't need the placeholder any more
        inProcess.delete(null);

        // Queue was empty, so it's up to us to run everybody's must/do()s
        for (const item of inProcess) {
            if (item._cbs) item._cbs = runChain(item._done, item._cbs);
            inProcess.delete(item);
            if (isUnhandled(item._done)) item.throw(markHandled(item._done));
        }
        popCtx();
    }

    restart() {
        if (!this._done && inProcess.size) {
            // if a tree of jobs is ending right now, we need to start
            // a new stack so that when we return, all our children's
            // callbacks will have finished running first.
            const old = inProcess;
            inProcess = new Set;
            this.end();
            inProcess = old;
        } else {
            this._end(CancelResult);
        }
        this._done = undefined;
        promises.delete(this);  // don't reuse any now-cancelled promise!
        return this;
    }

    _end(res: JobResult<T>) {
        if (this._done) throw new Error("Job already ended");
        this._done = res;
        this.end();
        return this;
    }

    throw(err: any) {
        if (this._done) {
            const parent: Job = (owners.get(this) || root);
            if (parent && parent !== this) parent.asyncThrow(err); else defaultCatch(err);
            return this;
        }
        return this._end(ErrorResult(err));
    }

    return(val: T)  { return this._end(ValueResult(val)); }

    then<T1=T, T2=never>(
        onfulfilled?: (value: T) => T1 | PromiseLike<T1>,
        onrejected?: (reason: any) => T2 | PromiseLike<T2>
    ): Promise<T1 | T2> {
        return nativePromise(this).then(onfulfilled, onrejected);
    }

    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
        return nativePromise(this).catch(onrejected);
    }

    finally(onfinally?: () => void): Promise<T> {
        return nativePromise(this).finally(onfinally);
    }

    *[Symbol.iterator](): JobIterator<T> {
        if (this._done) {
            return getResult(this._done);
        } else return yield (req: Request<T>) => {
            // XXX should this be a release(), so if the waiter dies we
            // don't bother? The downside is that it'd have to be mutual and
            // the resume is a no-op anyway in that case.
            this.do(res => fulfillPromise(resolver(req), rejecter(req), res));
        }
    }

    start<T>(fn?: StartFn<T> | StartObj<T>): Job<T>;
    start<T, This>(ctx: This, fn: StartFn<T, This>): Job<T>;
    start<T, This>(fnOrCtx: StartFn<T> | StartObj<T>|This, fn?: StartFn<T, This>) {
        if (!fnOrCtx) return new _Job(this);
        let init: StartFn<T, This>, result: StartObj<T> | OptionalCleanup;
        if (isFunction(fn)) {
            init = fn.bind(fnOrCtx as This);
        } else if (isFunction(fnOrCtx)) {
            init = fnOrCtx as StartFn<T, This>;
        } else if (fnOrCtx instanceof _Job) {
            return fnOrCtx;
        } else {
            result = fnOrCtx as StartObj<T>;
        }
        const job = new _Job<T>(this);
        try {
            if (init) result = job.run(init as StartFn<T>, job);
            if (result != null) {
                if (isFunction(result)) {
                    job.must(result);
                } else if (result instanceof GeneratorBase) {
                    job.run(runGen<T>, result as Yielding<T>, job);
                } else if (result instanceof _Job) {
                    if (result !== job) result.do(res => propagateResult(job, res));
                } else if (result instanceof Promise) {
                    // Duplicated because this will be monomorphic or low-poly,
                    // but next branch will always be megamorphic
                    (result as Promise<T>).then(
                        v => { job.result() || job.return(v); },
                        e => { job.result() || job.throw(e); }
                    );
                } else if (isFunction((result as Promise<T>).then)) {
                    (result as Promise<T>).then(
                        v => { job.result() || job.return(v); },
                        e => { job.result() || job.throw(e); }
                    );
                } else if (
                    isFunction((result as Yielding<T>)[Symbol.iterator]) &&
                    typeof result !== "string"
                ) {
                    job.run(runGen<T>, result as Yielding<T>, job);
                } else {
                    throw new TypeError("Invalid value/return for start()");
                }
            }
            return job;
        } catch(e) {
            job.end();
            throw e;
        }
    }

    connect<T>(src: Stream<T>, sink: Sink<T>, inlet?: Inlet): Connection {
        return this.start(job => void src(sink, job, inlet));
    }

    constructor(parent?: Job, stop?: CleanupFn) {
        if (parent || stop) {
            this.must((parent ||= getJob()).release(stop || this.end));
            (parent===root) || owners.set(this, parent);
        }
    }

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        pushCtx(this);
        try { return fn(...args); } finally { popCtx(); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const job = this;
        return <F> function (this: any) {
            pushCtx(job);
            try { return apply(fn, this, arguments); } finally { popCtx(); }
        }
    }

    must(cleanup?: OptionalCleanup) {
        if (isFunction(cleanup)) push(this._chain(), cleanup);
        return this;
    }

    release(cleanup: CleanupFn): () => void {
        let cbs = this._chain();
        if (!this._done || cbs.u) cbs = cbs.u ||= chain();
        return pushCB(cbs, cleanup);
    }

    asyncThrow(err: any) {
        try {
            (catchers.get(this) || this.throw).call(this, err);
        } catch (e) {
            // Don't allow a broken handler to stay on the job
            if (this === root) catchers.set(this, defaultCatch); else catchers.delete(this);
            const catcher = catchers.get(this) || this.throw;
            catcher.call(this, err);
            catcher.call(this, e);   // also report the broken handler
        }
        return this;
    }

    asyncCatch(handler: ((this: Job, err: any) => unknown) | null): this {
        if (isFunction(handler)) catchers.set(this, handler);
        else if (handler === null) catchers.delete(this);
        return this;
    }

    protected _done: JobResult<T> = undefined;

    // Chain whose .u stores a second chain for `release()` callbacks
    protected _cbs: Chain<CleanupFn<T>, Chain<CleanupFn<T>>> = undefined;
    protected _chain() {
        if (this._done && isEmpty(this._cbs)) defer(this.end);
        return this._cbs ||= chain();
    }
}

const promises = new WeakMap<Job<any>, Promise<any>>();

/**
 * Obtain a native promise for a job
 *
 * While jobs have the same interface as native promises, there are occasionally
 * reasons to just use one directly.  (Like when Uneventful uses this function
 * to implement jobs' promise methods!)
 *
 * @param job The job to get a native promise for.
 *
 * @returns A {@link Promise} that resolves or rejects according to whether the
 * job returns or throws.  If the job is canceled, the promise is rejected with
 * a {@link CancelError}.
 *
 * @category Jobs
 */
export function nativePromise<T>(job: Job<T>): Promise<T> {
    if (!promises.has(job)) {
        promises.set(job, new Promise((res, rej) => {
            const toPromise = (fulfillPromise<T>).bind(null, res, rej);
            if (job.result()) toPromise(job.result()); else job.do(toPromise);
        }));
    }
    return promises.get(job);
}

/**
 * This function is deprecated.  Please move to using `.start()` instead, as
 * shown:
 *
 * | Old | New |
 * | --- | --- |
 * | `makeJob()`<br>`makeJob(null/undefined)` | `root.start()` |
 * | `makeJob(parent)` | `parent.start()` |
 *
 * If for some reason you are currently using a custom `stop` function and need
 * to keep it for backward compatibility, you can use `.restart()` on the new
 * job to remove the default stop function from its parent, then replace it with
 * `.must(parent.release(stop))`.
 *
 * @deprecated
 * @category Jobs
 */
export function makeJob<T>(parent?: Job, stop?: CleanupFn): Job<T> {
    return new _Job<T>(parent, stop);
}

/**
 * The "main" job of the program or bundle, which all other jobs should be a
 * child of.  This provides a single point of configuration and cleanup, as one
 * can e.g.:
 *
 * - Use {@link Job.asyncCatch `root.asyncCatch()`} to define the default async
 *   error handling policy
 * - Use {@link Job.end `root.end()`} to clean up all resources for the entire
 *   program
 * - Use {@link Job.start `root.start()`} to create top-level, standalone, or
 *   "daemon"/service tasks, or to create tasks whose lifetime is managed by an
 *   external framework.
 *
 * By default, there is only ever one root job, run once, in a given process or
 * page.  But for testing you can use {@link newRoot} to end the existing root
 * and start a new one.
 *
 * @remarks
 * Uneventful does not include any code to end the root job itself, as the
 * decision of when and whether to do that varies heavily by context (e.g.
 * server vs. browser, app vs. plugin, etc.), and often doesn't need to happen
 * at all.  (Because exiting the process or leaving the web page is often
 * sufficient.)
 *
 * More commonly, you will only end the root job when running tests (to get a
 * clean environment for the next test), or when your entire bundle is itself an
 * unloadable plugin (e.g. in Obsidian).
 *
 * Note, too, that when the root job ends, root is reset to `null` so that any
 * subsequent attempt to use the root job will throw an exception.  (Unless of
 * course a new root job has been created with {@link newRoot}.)
 *
 * @category Jobs
 */
export let root: Job<unknown>;
newRoot()

/**
 * Create a new root job (usually for testing purposes). If there is an existing
 * root job, it is ended first.  The new root is configured to convert async
 * errors into unhandled promise rejections by default, so if you need to change
 * that you can use its {@link Job.asyncCatch `.asyncCatch()`} method.
 *
 * @returns The new root job.
 *
 * @remarks If your project customizes the root job in some way(s), you will
 * probably want a function to do that, so you can use it both in tests and at
 * runtime.  (e.g. `myInit(newJob())` in tests, and `myInit(root)` at runtime.)
 *
 * @category Jobs
 */
export function newRoot(): Job<unknown> {
    root?.end()
    const job = root = new _Job().asyncCatch(defaultCatch)
    // Make attempts to use `root` fail, if they are during or after its cleanup
    job.release(() => root === job && (root = null))
    return root;
}

function runGen<R>(g: Yielding<R>, job: Job<R>) {
    let it = g[Symbol.iterator](), running = true, j = job, ct = 0;
    let done = job.release(() => {
        job = undefined;
        ++ct; // disable any outstanding request(s)
        // XXX this should be deferred to cleanup phase, or must() instead of release
        // (release only makes sense here if you can run more than one generator in a job)
        step("return", undefined);
    });
    // Start asynchronously
    defer(() => { running = false; step("next", undefined); });

    function step(method: "next" | "throw" | "return", arg: any): void {
        if (!it) return;
        // Don't resume a job while it's running
        if (running) {
            return defer(step.bind(null, method, arg));
        }
        pushCtx(j);
        try {
            running = true;
            try {
                for(;;) {
                    ++ct;
                    const {done, value} = it[method](arg);
                    if (done) {
                        job && job.return(value);
                        job = undefined;
                        break;
                    } else if (!isFunction(value)) {
                        method = "throw";
                        arg = new TypeError("Jobs must yield functions (or yield* Yielding<T>s)");
                        continue;
                    } else {
                        let called = false, returned = false, count = ct;
                        (value as Suspend<any>)((op, val, err) => {
                            if (called) return; else called = true;
                            method = op; arg = op === "next" ? val : err;
                            if (returned && count === ct) step(op, arg);
                        });
                        returned = true;
                        if (!called) return;
                    }
                }
            } catch(e) {
                it = job = undefined;
                j.throw(e);
            }
            // Iteration is finished; disconnect from job
            it = undefined;
            done?.();
            done = undefined;
        } finally {
            popCtx();
            running = false;
        }
    }
}
