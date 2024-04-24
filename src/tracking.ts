import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { AnyFunction, CleanupFn, Job, Request, Yielding, Suspend, PlainFunction, Start, OptionalCleanup } from "./types.ts";
import { defer } from "./defer.ts";
import { JobResult, ErrorResult, CancelResult, isCancel, ValueResult, isError, isValue, noop } from "./results.ts";
import { resolve, reject } from "./results.ts";
import { Chain, chain, isEmpty, pop, push, pushCB, qlen, recycle, unshift } from "./chains.ts";

/**
 * Return the currently-active Job, or throw an error if none is active.
 *
 * (You can check if a job is active first using {@link isJobActive}().)
 *
 * @category Jobs
 */
export function getJob() {
    const {job} = current;
    if (job) return job;
    throw new Error("No job is currently active");
}

const nullCtx = makeCtx();

function runChain<T>(res: JobResult<T>, cbs: Chain<CleanupFn<T>>): undefined {
    while (qlen(cbs)) try { pop(cbs)(res); } catch (e) { Promise.reject(e); }
    cbs && recycle(cbs);
    return undefined;
}

/** The set of jobs whose callbacks  */
var inProcess = new Set<_Job<any>>;

class _Job<T> implements Job<T> {
    /** @internal */
    static create<T,R>(parent?: Job<R>, stop?: CleanupFn<R>): Job<T> {
        const job = new _Job<T>;
        if (parent || stop) job.must(
            (parent || getJob()).release(stop || job.end)
        );
        return job;
    }

    "uneventful/ext": {} = undefined

    do(cleanup: CleanupFn<T>): this {
        unshift(this._chain(), cleanup);
        return this;
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
        var p = new Promise<T>((res, rej) => {
            if (this._done) toPromise(this._done); else this.do(toPromise);
            function toPromise(r: JobResult<T>) {
                // XXX mark error handled
                if (isError(r)) rej(r.err); else if (isValue(r)) res(r.val); else rej(r);
            }
        })
        return (onfulfilled || onrejected) ? p.then(onfulfilled, onrejected) : p as any;
    }

    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
        return this.then(undefined, onrejected);
    }

    finally(onfinally?: () => void): Promise<T> {
        return this.then().finally(onfinally);
    }

    *[Symbol.iterator]() {
        if (this._done) {
            if (isValue(this._done)) return this._done.val;
            throw isError(this._done) ? this._done.err : this._done;
        } else return yield (req: Request<T>) => {
            // XXX should this be a release(), so if the waiter dies we
            // don't bother? The downside is that it'd have to be mutual and
            // the resume is a no-op anyway in that case.
            this.do(res => {
                if (isCancel(res)) req("throw", undefined, res); else req(res.op, res.val, res.err);
            });
        }
    }

    start<T>(fn?: Start<T>|Yielding<T>): Job<T>;
    start<T,C>(ctx: C, fn: Start<T,C>): Job<T>;
    start<T,C>(fnOrCtx: Start<T>|Yielding<T>|C, fn?: Start<T,C>) {
        if (!fnOrCtx) return makeJob(this);
        let init: Start<T,C>;
        if (typeof fn === "function") {
            init = fn.bind(fnOrCtx as C);
        } else if (typeof fnOrCtx === "function") {
            init = fnOrCtx as Start<T,C>;
        } else if (fnOrCtx instanceof _Job) {
            return fnOrCtx;
        } else if (typeof fnOrCtx[Symbol.iterator] === "function") {
            init = () => fnOrCtx as Yielding<T>;
        } else {
            // XXX handle promises or other things here?
            throw new TypeError("Invalid argument for start()");
        }
        const job = makeJob<T>(this);
        try {
            const result = job.run(init as Start<T>, job);
            if (typeof result === "function") return job.must(result);
            if (result && typeof result[Symbol.iterator] === "function") {
                job.run(runGen, result, <Request<T>>((m, v, e) => {
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
        return <F> function () {
            const old = swapCtx(makeCtx(job));
            try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
        }
    }

    must(cleanup?: OptionalCleanup<T>) {
        if (typeof cleanup === "function") push(this._chain(), cleanup);
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
 *   begin with; a cleanup callback will be added to the job as a `must()`.
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
    return getJob().start(fnOrCtx, fn);
}

/**
 * Is there a currently active job? (i.e., can you safely use {@link must}(),
 * or {@link getJob}() right now?)
 *
 * @category Jobs
 */
export function isJobActive() { return !!current.job; }

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
    const outer = getJob(), inner = makeJob<never>(), {end} = inner;
    task ||= <F>((f: () => OptionalCleanup<never>) => { inner.must(f()); });
    return <F>function() {
        inner.restart().must(outer.release(end));
        const old = swapCtx(makeCtx(inner));
        try { return task.apply(this, arguments as any); }
        catch(e) { inner.throw(e); throw e; }
        finally { freeCtx(swapCtx(old)); }
    };
}


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
                    } else if (typeof value !== "function") {
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
