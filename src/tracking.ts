import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { CleanupFn, Job, Request, Yielding, Suspend, PlainFunction, Start, OptionalCleanup, JobIterator } from "./types.ts";
import { defer } from "./defer.ts";
import { JobResult, ErrorResult, CancelResult, isCancel, ValueResult, isError, isValue, noop, markHandled } from "./results.ts";
import { resolve, reject } from "./results.ts";
import { Chain, chain, isEmpty, pop, push, pushCB, qlen, recycle, unshift } from "./chains.ts";

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

const nullCtx = makeCtx();

function runChain<T>(res: JobResult<T>, cbs: Chain<CleanupFn<T>>): undefined {
    while (qlen(cbs)) try { pop(cbs)(res); } catch (e) { Promise.reject(e); }
    cbs && recycle(cbs);
    return undefined;
}

// The set of jobs whose callbacks need running during an end() sweep
var inProcess = new Set<_Job<any>>;

class _Job<T> implements Job<T> {
    /** @internal */
    static create<T,R>(parent?: Job<R>, stop?: CleanupFn<R>): Job<T> {
        const job = new _Job<T>;
        if (parent || stop) job.must(
            (parent || getJob() as Job<R>).release(stop || job.end)
        );
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

    result() { return this._done; }

    get [Symbol.toStringTag]() { return "Job"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs;
        if (!cbs) return;  // nothing to do here

        const ct = inProcess.size, old = swapCtx(nullCtx);;
        // Put a placeholder on the queue if it's empty
        if (!ct) inProcess.add(null);

        // Give priority to the release() chain so we get breadth-first flagging
        // of all child jobs as canceled immediately
        if (cbs.u) cbs.u = runChain(res, cbs.u);

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

    throw(err: any) { return this._end(ErrorResult(err)); }
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
            if (isValue(this._done)) return this._done.val;
            throw isError(this._done) ? markHandled(this._done) : this._done;
        } else return yield (req: Request<T>) => {
            // XXX should this be a release(), so if the waiter dies we
            // don't bother? The downside is that it'd have to be mutual and
            // the resume is a no-op anyway in that case.
            this.do(res => {
                if (isError(res)) markHandled(res);
                if (isCancel(res)) req("throw", undefined, res); else req(res.op, res.val, res.err);
            });
        }
    }

    start<T>(fn?: Start<T>|Yielding<T>): Job<T>;
    start<T,C>(ctx: C, fn: Start<T,C>): Job<T>;
    start<T,C>(fnOrCtx: Start<T>|Yielding<T>|C, fn?: Start<T,C>) {
        if (!fnOrCtx) return makeJob(this);
        let init: Start<T,C>;
        if (isFunction(fn)) {
            init = fn.bind(fnOrCtx as C);
        } else if (isFunction(fnOrCtx)) {
            init = fnOrCtx as Start<T,C>;
        } else if (fnOrCtx instanceof _Job) {
            return fnOrCtx;
        } else if (isFunction((fnOrCtx as Yielding<T>)[Symbol.iterator])) {
            init = () => fnOrCtx as Yielding<T>;
        } else {
            // XXX handle promises or other things here?
            throw new TypeError("Invalid argument for start()");
        }
        const job = makeJob<T>(this);
        try {
            const result = job.run(init as Start<T>, job);
            if (isFunction(result)) return job.must(result);
            if (result && isFunction(result[Symbol.iterator])) {
                job.run(runGen<T>, result, <Request<T>>((m, v, e) => {
                    if (job.result()) return;
                    if (m==="next") job.return(v); else job.throw(e);
                }));
            }
            return job;
        } catch(e) {
            job.end();
            throw e;
        }
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
 * {@link CancelResult}.
 *
 * @category Jobs
 */
export function nativePromise<T>(job = getJob<T>()): Promise<T> {
    if (!promises.has(job)) {
        promises.set(job, new Promise((res, rej) => {
            if (job.result()) toPromise(job.result()); else job.do(toPromise);
            function toPromise(r: JobResult<T>) {
                if (isError(r)) rej(markHandled(r)); else if (isValue(r)) res(r.val); else rej(r);
            }
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
 * jobs.  detached.start() returns a new detached job, detached.run() can be used
 * to run code that expects to create a child job, and detached.bind() can wrap
 * a function to work without a parent job.
 *
 * (Note that in all cases, a child job of `detached` must be stopped explicitly, or
 * it may "run" forever, never running its cleanup callbacks.)
 *
 * @category Jobs
 */
export const detached = makeJob();
(detached as any).end = () => { throw new Error("Can't do that with the detached job"); }

function runGen<R>(g: Yielding<R>, req?: Request<R>) {
    let it = g[Symbol.iterator](), running = true, ctx = makeCtx(getJob()), ct = 0;
    let done = ctx.job.release(() => {
        req = undefined;
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
                        req && resolve(req, value);
                        req = undefined;
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
                req ? reject(req, e) : Promise.reject(e);
                req = undefined;
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
