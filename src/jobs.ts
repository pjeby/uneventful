import { current, makeCtx, swapCtx } from "./ambient.ts";
import { JobIterator, Request, Suspend, Yielding } from "./async.ts";
import { defer } from "./defer.ts";
import { CleanupFn, DisposeFn, runner } from "./tracking.ts";

/**
 * A cancellable asynchronous task.  (Created using {@link job}().)
 *
 * Jobs implement the Promise interface (then, catch, and finally) so they can
 * be passed to Promise-using APIs or awaited by async functions.  They also
 * implement {@link Yielding}, so you can await their results in other jobs
 * using `yield *`.
 *
 * You can abort a job by throwing errors into it or executing a return() that
 * will run all its `finally` blocks (if the job's a generator).
 *
 * Last, but not least, you can register cleanup callbacks with a job using its
 * .{@link Job.onEnd onEnd}() and
 * .{@link Job.linkedEnd linkedEnd}() methods.
 *
 * @category Types and Interfaces
 */
export interface Job<T> extends Promise<T>, Yielding<T> {
    /** Terminate the activity with a given result */
    return(val?: T): void;

    /** Terminate the activity with an error */
    throw(error: any): void;

    /** Register a callback to run when the activity ends */
    onEnd(cb: () => void): void;

    /** Like onEnd, but with the ability to remove the callback */
    linkedEnd(cleanup: CleanupFn): DisposeFn
}

/**
 * Create a new {@link Job} or fetch the currently-running one
 *
 * If *no* arguments are given, returns the current job (if any).
 *
 * If *one* argument is given, it should be either a {@link Yielding} object (like
 * a generator), or a no-arguments function returning a Yielding (like a
 * generator function).
 *
 * If *two* arguments are given, the second should be the no-arguments function,
 * and the first is a `this` object the function should be called with.  (This
 * two-argument form is needed since you can't make generator arrows in JS yet.)
 *
 * (Note that TypeScript and/or VSCode may require that you give such a function
 * an explicit `this` parameter (e.g. `job(this, function *(this) {...}));`) in
 * order to correctly infer types inside a generator function.)
 *
 * @returns A new {@link Job}, or the current job (which may be undefined).
 *
 * @category Flows
 * @category Jobs and Scheduling
 */
export function job<R,T>(thisObj: T, fn: (this:T) => Yielding<R>): Job<R>
export function job<R>(fn: (this:void) => Yielding<R>): Job<R>
export function job(): Job<unknown> | undefined
export function job<R>(g: Yielding<R>): Job<R>
export function job<R>(g?: Yielding<R> | ((this:void) => Yielding<R>), fn?: () => Yielding<R>): Job<R> {
    if (g || fn) {
        // Convert g or fn from a function to a yielding
        if (typeof fn === "function") g = fn.call(g); else if (typeof g === "function") g = g();
        // Return existing job or create a new one
        return (g instanceof _Job) ? g : new _Job(g[Symbol.iterator]());
    } else return current.job;
}

class _Job<T> implements Job<T> {

    // pretend to be a promise
    declare [Symbol.toStringTag]: string;

    constructor(protected g: JobIterator<T>) {
        this._r.flow.onEnd(() => {
            // Check for untrapped error, promote to unhandled rejection
            if ((this._f & (Is.Error | Is.Promised)) === Is.Error) {
                Promise.reject(this._res);
            }
        })
        // Start asynchronously
        defer(() => { this._f &= ~Is.Running; this._step("next", undefined); });
    }

    [Symbol.iterator]() {
        if (this._iter) return this._iter;
        const suspend: IteratorYieldResult<Suspend<T>> = {
            done: false,
            value: (request: Request<T>) => {
                this._f |= Is.Promised;
                // XXX should this be a linkedEnd so if the waiter dies we
                // don't bother? The downside is that it'd have to be mutual and
                // the resume is a no-op anyway in that case.
                this.onEnd(() => {
                    request((this._f & Is.Error) === Is.Error ? "throw" : "next", this._res, this._res);
                });
            }
        }
        return this._iter = {
            next: (): IteratorResult<Suspend<T>, T> => {
                if (this._f & Is.Finished) {
                    this._f |= Is.Promised;
                    if ((this._f & Is.Error) === Is.Error) throw this._res;
                    return {done: true, value: this._res};
                }
                return suspend;
            },
            throw: e => { throw e }  // propagate to yield*
        }
    }

    onEnd(cb: CleanupFn): void {
        return this._ctx.flow.onEnd(cb);
    }

    linkedEnd(cleanup: CleanupFn): DisposeFn {
        return this._ctx.flow.linkedEnd(cleanup);
    }

    then<T1=T, T2=never>(
        onfulfilled?: (value: T) => T1 | PromiseLike<T1>,
        onrejected?: (reason: any) => T2 | PromiseLike<T2>
    ): Promise<T1 | T2> {
        this._f |= Is.Promised;
        return new Promise((res, rej) => this.onEnd(() => {
            if ((this._f & Is.Error) === Is.Error) rej(this._res); else res(this._res);
        })).then(onfulfilled, onrejected);
    }

    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
        return this.then(undefined, onrejected);
    }

    finally(onfinally?: () => void): Promise<T> {
        return this.then().finally(onfinally);
    }

    return(v?: T)   { this._step("return", v); }
    throw(e: any)   { this._step("throw",  e); }

    // === Internals === //
    protected _r = runner(null, this.return.bind(this, undefined));
    protected readonly _ctx = makeCtx(this, this._r.flow);
    protected _f = Is.Running;
    protected _res: any
    protected _iter: JobIterator<T>;
    protected _ct = 0;
    protected _parent = current.job;

    protected _step(method: "next" | "throw" | "return", arg: any): void {
        if (!this.g) return;
        // Don't resume a job while it's running
        if (this._f & Is.Running) {
            return defer(this._step.bind(this, method, arg));
        }
        const old = swapCtx(this._ctx);
        try {
            this._f |= Is.Running;
            try {
                for(;;) {
                    ++this._ct;
                    const {done, value} = this.g[method](arg);
                    if (done) {
                        this._res = value;
                        this._f |= Is.Finished;
                        break;
                    } else if (typeof value !== "function") {
                        method = "throw";
                        arg = new TypeError("Jobs must yield functions (or yield* Yielding<T>s)");
                        continue;
                    } else {
                        let called = false, returned = false, count = this._ct;
                        (value as Suspend<any>)((op, val, err) => {
                            if (called) return; else called = true;
                            method = op; arg = op === "next" ? val : err;
                            if (returned && count === this._ct) this._step(op, arg);
                        });
                        returned = true;
                        if (!called) return;
                    }
                }
            } catch(e) {
                this._res = e;
                this._f |= Is.Error;
            }
            // Generator returned or threw: ditch it and run cleanups
            this.g = undefined;
            this._r.end();
        } finally {
            swapCtx(old);
            this._f &= ~Is.Running;
        }
    }
}

const enum Is {
    Unset = 0,
    _ = 1,
    Running  = _ << 0,
    Finished = _ << 1,
    Error    = (_ << 2 | Finished),
    Promised = _ << 3,
}

