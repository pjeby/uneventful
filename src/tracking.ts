import { pushCtx, popCtx, currentCtx, currentCell, cellCtx } from "./ambient.ts";
import { catchers, defaultCatch, owners } from "./internals.ts";
import {
    Activity, Cancellable, Checkpoint, CleanupFn, Context,  Coroutine, Eventual, Future, Job, OptionalCleanup,
    PlainFunction, RecalcSource, Request, Scope, Suspend, Task, ActivityFn, Yieldable, Work,
} from "./types.ts";
import { defer } from "./defer.ts";
import {
    CancelResult, ErrorResult, Result, ValueResult, isCancel, isError, isUnhandled, isValue, markHandled,
    propagateResult
} from "./results.ts";
import { rejecter, resolver, getResult, fulfillPromise } from "./results.ts";
import { Chain, chain, isEmpty, pop, push, pushCB, recycle, unshift } from "./chains.ts";
import { Stream, Sink, Inlet } from "./streams.ts";
import { GeneratorBase, apply } from "./utils.ts";
import { isFunction } from "./utils.ts";

/**
 * Return the current ambient execution context, or throw an error if none is available.
 *
 * (You can check if a context is active first using {@link inContext}().)
 *
 * @category Tasks and Context
 */
export function currentContext(): Context {
    const ctx = currentCtx || cellCtx();
    if (ctx) return ctx;
    throw new Error("No context is current");
}

/** RecalcSource factory for tasks (so you can wait on a task result in a signal or rule) */
function recalcTask(work: Work<any>): RecalcSource { return (cb => { currentContext().must(work.release(cb)); }); }

function runChain<T>(res: Result<T>, cbs: Chain<CleanupFn<T>>): undefined {
    let cb: CleanupFn<T>;
    while (cb = pop(cbs)!) try { cb(res); } catch (e) { root.asyncThrow(e); }
    cbs && recycle(cbs);
    return undefined;
}

// The set of contexs whose callbacks need running during an end() sweep
var inProcess = new Set<_Job<any>>;

export class _Job<T> implements Task<T>, Work<T>, Checkpoint {

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

    result(): Result<T> | undefined {
        // If we're done, we're done; otherwise make signals/rules reading this
        // recalc when we're done (handy for rendering "loading" states).
        return this._done || (currentCell && currentCell.recalcWhen(this, recalcTask)) || undefined;
    }

    get [Symbol.toStringTag]() { return "Job"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs;
        // if we have an unhandled error, fall through to queued mode for later
        // re-throw; otherwise, if there aren't any callbacks we're done here
        if (!cbs && !isUnhandled(res)) return;

        const ct = inProcess.size; pushCtx();
        // Put a placeholder on the queue if it's empty
        if (!ct) inProcess.add(null!);

        // Give priority to the release() chain so we get breadth-first flagging
        // of all child jobs as canceled immediately
        if (cbs && cbs.u) cbs.u = (runChain(res, cbs.u), undefined!);

        // Put ourselves on the queue *after* our children, so their cleanups run first
        inProcess.add(this);

        // if the queue wasn't empty, there's a loop above us that will run our must/do()s
        if (ct) { popCtx(); return; }

        // don't need the placeholder any more
        inProcess.delete(null!);

        // Queue was empty, so it's up to us to run everybody's must/do()s
        for (const item of inProcess) {
            if (item._cbs) item._cbs = (runChain(item._done, item._cbs), undefined!);
            inProcess.delete(item);
            if (isUnhandled(item._done)) item.throw(markHandled(item._done));
        }
        popCtx();
    }

    restart() { return this. reset() }

    reset() {
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
        this._done = undefined!;
        promises.delete(this);  // don't reuse any now-cancelled promise!
        return this;
    }

    _end(res: Result<T>) {
        if (this._done) throw new Error("Work already ended");
        this._done = res;
        this.end();
        return this;
    }

    cleaningUp() {
        return !!this._done
    }

    throw(err: any) {
        if (this._done) {
            const parent = (owners.get(this) || root);
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

    *[Symbol.iterator](): Coroutine<T> {
        if (this._done) {
            return getResult(this._done);
        } else return yield (req: Request<T>) => {
            // XXX should this be a release(), so if the waiter dies we
            // don't bother? The downside is that it'd have to be mutual and
            // the resume is a no-op anyway in that case.
            this.do(res => {
                // Async resume: don't let generators run while listened-to task
                // is cleaning up.  Deferring ensures the scope is fully cleaned
                // up before listeners resume.
                defer(() => fulfillPromise(resolver(req), rejecter(req), res))
                isError(res) && markHandled(res) // must be done early to prevent unhandled propagation
            })
        }
    }

    checkpoint(): Checkpoint {
        return new _Job(this).reset()
    }

    starting<T>(...activities: Activity<T>[]): Work<T> {
        const work = new _Job<T>(this)
        if (activities.length) {
            try {
                activities.forEach(work.exec, work)
            } catch(e) {
                work.end();
                throw e;
            }
        }
        return work
    }

    task() { return this as Task<T> }
    future() { return this as Future<T> }

    start<T>(fn: Activity<T>): Task<T>;
    start<T>(): Job<T>
    start<T, This>(ctx: This, fn: ActivityFn<T, This>): Task<T>;
    start<T, This>(fnOrCtx?: Activity<T>|This, fn?: ActivityFn<T, This>) {
        if (!fnOrCtx) return new _Job(this);
        let init: ActivityFn<T, This>, result: Eventual<T> | OptionalCleanup;
        if (isFunction(fn)) {
            init = fn.bind(fnOrCtx as This);
        } else if (isFunction(fnOrCtx)) {
            init = fnOrCtx as ActivityFn<T, This>;
        } else if (fnOrCtx instanceof _Job) {
            return fnOrCtx;
        } else {
            result = fnOrCtx as Eventual<T>;
        }
        const work = new _Job<T>(this);
        try {
            return work.exec(result as Eventual<T> ?? init!)
        } catch(e) {
            work.end();
            throw e;
        }
    }

    exec(init: Activity<T>): this {
        if (this._done) return this
        var result: Eventual<T> | OptionalCleanup
        result = isFunction(init) ? this.run(init as ActivityFn<T>, this) : init;
        if (result != null) {
            if (isFunction(result)) {
                this.must(result);
            } else if (result instanceof GeneratorBase) {
                this.run(runGen<T>, result as Yieldable<T>, this);
            } else if (result instanceof _Job) {
                if (result !== this) result.do(res => propagateResult(this, res));
            } else if (result instanceof Promise) {
                // Duplicated because this will be monomorphic or low-poly,
                // but next branch will always be megamorphic
                (result as Promise<T>).then(
                    v => { this.result() || this.return(v); },
                    e => { this.result() || this.throw(e); }
                );
            } else if (isFunction((result as Promise<T>).then)) {
                (result as Promise<T>).then(
                    v => { this.result() || this.return(v); },
                    e => { this.result() || this.throw(e); }
                );
            } else if (
                isFunction((result as Yieldable<T>)[Symbol.iterator]) &&
                typeof result !== "string"
            ) {
                this.run(runGen<T>, result as Yieldable<T>, this);
            } else {
                throw new TypeError("Invalid value/return for start/exec()");
            }
        }
        return this
    }

    connect<T>(src: Stream<T>, sink: Sink<T>, inlet?: Inlet): Task {
        return this.start(work => void src(sink, work, inlet));
    }

    constructor(parent?: Context, stop?: CleanupFn) {
        if (parent || stop) {
            this.must((parent ||= currentContext()).release(stop || this.end));
            (parent===root) || owners.set(this, parent);
        }
    }

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        pushCtx(this);
        try { return fn(...args); } finally { popCtx(); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const ctx = this;
        return <F> function (this: any) {
            pushCtx(ctx);
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
            // Don't allow a broken handler to stay on the scope
            if (this === root) catchers.set(this, defaultCatch); else catchers.delete(this);
            const catcher = catchers.get(this) || this.throw;
            catcher.call(this, err);
            catcher.call(this, e);   // also report the broken handler
        }
        return this;
    }

    asyncCatch(handler: ((this: Context, err: any) => unknown) | null): this {
        if (isFunction(handler)) catchers.set(this, handler);
        else if (handler === null) catchers.delete(this);
        return this;
    }

    protected _done: Result<T> = undefined!;

    // Chain whose .u stores a second chain for `release()` callbacks
    protected _cbs: Chain<CleanupFn<T>, Chain<CleanupFn<T>>> = undefined!;
    protected _chain() {
        if (this._done && isEmpty(this._cbs)) defer(this.end);
        return this._cbs ||= chain();
    }
}

const promises = new WeakMap<Future<any>, Promise<any>>();

/**
 * Obtain a native promise for a {@link Future} or {@link Task}
 *
 * While tasks and futures have the same interface as native promises, there are
 * occasionally reasons to just use one directly.  (For example, Uneventful
 * actually uses this function to implement futures' promise methods!)
 *
 * @param future The future or task to get a native promise for.
 *
 * @returns A native {@link Promise} that resolves or rejects according to
 * whether the future fulfills or rejects.  If the future is canceled, the
 * promise is rejected with a {@link CancelError}.
 *
 * @category Tasks and Context
 */
export function nativePromise<T>(future: Future<T>): Promise<T> {
    if (!promises.has(future)) {
        promises.set(future, new Promise((res, rej) => {
            const toPromise = (fulfillPromise<T>).bind(null, res, rej);
            const result = future.result()
            if (result) toPromise(result); else future.do(toPromise);
        }));
    }
    return promises.get(future)!;
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
 * to keep it for backward compatibility, you can use .reset()` on the new
 * job to remove the default stop function from its parent, then replace it with
 * `.must(parent.release(stop))`.
 *
 * @deprecated
 * @hidden
 * @category Tasks and Context
 */
export function makeJob<T>(parent?: Job, stop?: CleanupFn): Job<T> {
    return new _Job<T>(parent, stop);
}

/**
 * The "main" context of the program or bundle, which all other tasks and contexts
 * should be a child of.  This provides a single point of configuration and
 * cleanup, as one can e.g.:
 *
 * - Use {@link Scope.asyncCatch `root.asyncCatch()`} to define the default async
 *   error handling policy
 * - Use {@link Cancellable.end `root.end()`} to clean up all resources for the entire
 *   program
 * - Use {@link Context.start `root.start()`} to create top-level, standalone, or
 *   "daemon"/service tasks, or to create tasks whose lifetime is managed by an
 *   external framework.
 *
 * By default, there is only ever one root scope in a given process or
 * page.  But for testing you can use {@link newRoot} to end the existing root
 * and replace it with a new one.
 *
 * @remarks
 * Uneventful does not include any code to end the root scope itself, as the
 * decision of when and whether to do that varies heavily by context (e.g.
 * server vs. browser, app vs. plugin, etc.), and often doesn't need to happen
 * at all.  (Because exiting the process or leaving the web page is often
 * sufficient.)
 *
 * More commonly, you will only end the root scope when running tests (to get a
 * clean environment for the next test), or when your entire bundle is itself an
 * unloadable plugin (e.g. in Obsidian).
 *
 * Note, too, that when the root scope ends, root is reset to `null` so that any
 * subsequent attempt to use the root scope will throw an exception.  (Unless of
 * course a new root has been created with {@link newRoot}.)
 *
 * @category Tasks and Context
 */
export let root: Scope;
export let rootId = 0
let latestCatch = defaultCatch
newRoot()

/**
 * Create a new root scope (usually for testing purposes). If there is an
 * existing root scope, it is ended first.  The new root inherits the previous
 * root scope's {@link Scope.asyncCatch `.asyncCatch()`} handler, if it
 * had one.  (Otherwise, the new root is configured to convert async errors into
 * unhandled promise rejections by default.)
 *
 * @returns The new root scope.
 *
 * @remarks If your project customizes the root scope in some way(s), you will
 * probably want a function to do that, so you can use it both in tests and at
 * runtime.  (e.g. `myInit(newRoot())` in tests, and `myInit(root)` at runtime.)
 *
 * @category Tasks and Context
 */
export function newRoot(): Scope {
    root?.end()
    ++rootId
    const scope: Scope = root = new _Job().asyncCatch(latestCatch)
    // Make attempts to use `root` fail, if they are during or after its cleanup
    scope.release(() => root === scope && (root = null!, latestCatch = catchers.get(scope) || defaultCatch))
    return root;
}

function runGen<R>(g: Yieldable<R>, work: Work<R>) {
    let it = g[Symbol.iterator](), running = true, ctx = work, ct = 0;
    let disconnect = work.release(() => {
        work = undefined!;
        ++ct; // disable any outstanding request(s)
        ctx.must(() => step("return", undefined))  // defer to cleanup phase
    });
    // Start asynchronously
    defer(() => { running = false; !work || step("next", undefined); });

    function step(method: "next" | "throw" | "return", arg: any): void {
        if (!it) return;
        // Don't resume a coroutine while it's running
        if (running) {
            return defer(step.bind(null, method, arg));
        }
        pushCtx(ctx);
        try {
            running = true;
            try {
                for(;;) {
                    ++ct;
                    const {done, value} = it[method](arg);
                    if (done) {
                        work && work.return(value);
                        work = undefined!;
                        break;
                    } else if (!isFunction(value)) {
                        method = "throw";
                        arg = new TypeError("Coroutines must yield functions (or yield* Yieldable<T>s)");
                        continue;
                    } else {
                        if (method === "return") continue
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
                it = work = undefined!;
                ctx.throw(e);
            }
            // Iteration is finished; disconnect from work
            it = undefined!;
            disconnect?.();
            disconnect = undefined!;
        } finally {
            popCtx();
            running = false;
        }
    }
}

/** @hidden @deprecated use {@link currentContext} instead */
export function getJob<T=unknown>() {
    return currentContext() as Job<T>
}
