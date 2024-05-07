import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { catchers, defaultCatch, nullCtx, owners } from "./internals.ts";
import { CleanupFn, Job, Request, Yielding, Suspend, PlainFunction, StartFn, OptionalCleanup, JobIterator, RecalcSource, StartObj } from "./types.ts";
import { defer } from "./defer.ts";
import { JobResult, ErrorResult, CancelResult, isCancel, ValueResult, isError, isValue, noop, markHandled, isUnhandled, propagateResult } from "./results.ts";
import { rejecter, resolver, getResult, fulfillPromise } from "./results.ts";
import { Chain, chain, isEmpty, pop, push, pushCB, qlen, recycle, unshift } from "./chains.ts";
import { Source, Sink, Inlet, Connection } from "./streams.ts";

/**
 * Is the given value a function?
 *
 * @category Types and Interfaces
 */
export function isFunction(f: any): f is Function {
    return typeof f === "function";
}

/**
 * Return the currently-active Job, or throw an error if none is active.
 *
 * (You can check if a job is active first using {@link isJobActive}().)
 *
 * @category Jobs
 */
export function getJob<T=unknown>() {
    const {job} = current;
    if (job) return job as Job<T>;
    throw new Error("No job is currently active");
}

/** RecalcSource factory for jobs (so you can wait on a job result in a signal or rule) */
function recalcJob(job: Job<any>): RecalcSource { return (cb => { current.job.must(job.release(cb)); }); }

function runChain<T>(res: JobResult<T>, cbs: Chain<CleanupFn<T>>): undefined {
    while (qlen(cbs)) try { pop(cbs)(res); } catch (e) { detached.asyncThrow(e); }
    cbs && recycle(cbs);
    return undefined;
}

// The set of jobs whose callbacks need running during an end() sweep
var inProcess = new Set<_Job<any>>;

class _Job<T> implements Job<T> {
    /** @internal */
    static create<T,R>(parent?: Job<R>, stop?: CleanupFn<R>): Job<T> {
        const job = new _Job<T>;
        if (parent || stop) {
            job.must((parent ||= getJob() as Job<R>).release(stop || job.end));
            owners.set(job, parent);
        }
        return job;
    }

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
        return this._done || current.cell?.recalcWhen(this, recalcJob) || undefined;
    }

    get [Symbol.toStringTag]() { return "Job"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs;
        // if we have an unhandled error, fall through to queued mode for later
        // re-throw; otherwise, if there aren't any callbacks we're done here
        if (!cbs && !isUnhandled(res)) return;

        const ct = inProcess.size, old = swapCtx(nullCtx);;
        // Put a placeholder on the queue if it's empty
        if (!ct) inProcess.add(null);

        // Give priority to the release() chain so we get breadth-first flagging
        // of all child jobs as canceled immediately
        if (cbs && cbs.u) cbs.u = runChain(res, cbs.u);

        // Put ourselves on the queue *after* our children, so their cleanups run first
        inProcess.add(this);

        // if the queue wasn't empty, there's a loop above us that will run our must/do()s
        if (ct) { swapCtx(old); return; }

        // don't need the placeholder any more
        inProcess.delete(null);

        // Queue was empty, so it's up to us to run everybody's must/do()s
        for (const item of inProcess) {
            if (item._cbs) item._cbs = runChain(item._done, item._cbs);
            inProcess.delete(item);
            if (isUnhandled(item._done)) item.throw(markHandled(item._done));
        }
        swapCtx(old);
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
        if (this !== detached) this._done = res;
        this.end();
        return this;
    }

    throw(err: any) {
        if (this._done) {
            (owners.get(this) || detached).asyncThrow(err);
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
        if (!fnOrCtx) return makeJob(this);
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
        const job = makeJob<T>(this);
        try {
            if (init) result = job.run(init as StartFn<T>, job);
            if (result != null) {
                if (result instanceof _Job) {
                    if (result !== job) result.do(res => propagateResult(job, res));
                } else if (isFunction((result as Promise<T>).then)) {
                    (result as Promise<T>).then(
                        v => { job.result() || job.return(v); },
                        e => { job.result() || job.throw(e); }
                    );
                    return job;
                } else if (
                    isFunction((result as Yielding<T>)[Symbol.iterator]) &&
                    typeof result !== "string"
                ) {
                    job.run(runGen<T>, result as Yielding<T>, job);
                } else if (isFunction(result)) {
                    job.must(result);
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

    connect<T>(src: Source<T>, sink: Sink<T>, inlet?: Inlet): Connection {
        return this.start(job => void src(sink, job, inlet));
    }

    protected constructor() {};

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const job = this;
        return <F> function (this: any) {
            const old = swapCtx(makeCtx(job));
            try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
        }
    }

    must(cleanup?: OptionalCleanup<T>) {
        if (isFunction(cleanup)) push(this._chain(), cleanup);
        return this;
    }

    release(cleanup: CleanupFn<T>): () => void {
        if (this === detached) return noop;
        let cbs = this._chain();
        if (!this._done || cbs.u) cbs = cbs.u ||= chain();
        return pushCB(cbs, cleanup);
    }

    asyncThrow(err: any) {
        try {
            (catchers.get(this) || this.throw).call(this, err);
        } catch (e) {
            // Don't allow a broken handler to stay on the job
            if (this === detached) catchers.set(this, defaultCatch); else catchers.delete(this);
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
        if (this === detached) this.end()
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
 * @param job Optional: the job to get a native promise for.  If none is given,
 * the active job is used.
 *
 * @returns A {@link Promise} that resolves or rejects according to whether the
 * job returns or throws.  If the job is canceled, the promise is rejected with
 * a {@link CancelError}.
 *
 * @category Jobs
 */
export function nativePromise<T>(job = getJob<T>()): Promise<T> {
    if (!promises.has(job)) {
        promises.set(job, new Promise((res, rej) => {
            const toPromise = (fulfillPromise<T>).bind(null, res, rej);
            if (job.result()) toPromise(job.result()); else job.do(toPromise);
        }));
    }
    return promises.get(job);
}

/**
 * Return a new {@link Job}.  If *either* a parent parameter or stop function
 * are given, the new job is linked to the parent.
 *
 * @param parent The parent job to which the new job should be attached.
 * Defaults to the currently-active job if none given (assuming a stop
 * parameter is provided).
 *
 * @param stop The function to call to destroy the nested job.  Defaults to the
 * {@link Job.end} method of the new job if none is given (assuming a parent
 * parameter is provided).
 *
 * @returns A new job.  The job is linked/nested if any arguments are given,
 * or a detached (parentless) job otherwise.
 *
 * @category Jobs
 */
export const makeJob: <T,R=unknown>(parent?: Job<R>, stop?: CleanupFn<R>) => Job<T> = _Job.create;

/**
 * A special {@link Job} with no parents, that can be used to create standalone
 * jobs.  detached.start() returns a new detached job, detached.run() can be
 * used to run code that expects to create a child job, and detached.bind() can
 * wrap a function to work without a parent job.
 *
 * (Note that in all cases, a child job of `detached` *must* be stopped
 * explicitly, or it may "run" forever, never running its cleanup callbacks.)
 *
 * The detached job has a few special features and limitations:
 *
 * - It can't be ended, thrown, return()ed, etc. -- you'll get an error
 *
 * - It can't have any cleanup functions added: no do, must, onError, etc., and
 *   thus also can't have any native promise, abort signal, etc. used.  You can
 *   call its release() method, but nothing will actually be registered and the
 *   returned callback is a no-op.
 *
 * - Unhandled errors from jobs without parents (and errors from *any* job's
 *   cleanup functions) are sent to the detached job for handling.  This means
 *   whatever you set as the detached job's .{@link Job.asyncCatch asyncCatch}()
 *   handler will receive them.  (Its default is Promise.reject, causing an
 *   unhandled promise rejection.)
 *
 * @category Jobs
 */
export const detached = makeJob();
(detached as any).end = () => { throw new Error("Can't do that with the detached job"); }
detached.asyncCatch(defaultCatch);

function runGen<R>(g: Yielding<R>, job: Job<R>) {
    let it = g[Symbol.iterator](), running = true, ctx = makeCtx(job), ct = 0;
    let done = ctx.job.release(() => {
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
        const old = swapCtx(ctx);
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
                ctx.job.throw(e);
            }
            // Iteration is finished; disconnect from job
            it = undefined;
            done?.();
            done = undefined;
        } finally {
            swapCtx(old);
            running = false;
        }
    }
}
