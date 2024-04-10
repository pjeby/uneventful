/**
 * A cleanup function is a callback invoked when a flow is ended or restarted.
 * It receives a result that indicates whether the flow ended itself with a return
 * value or error, or was canceled/restarted by its creator.
 *
 * @category Types and Interfaces
 */
export type CleanupFn<T=any> = (res?: FlowResult<T>) => unknown;

/**
 * A function that can be called to dispose of something or unsubscribe
 * something.  It's called without arguments and returns void.
 *
 * @category Types and Interfaces
 */
export type DisposeFn = () => void;

/**
 * An optional cleanup parameter or return.
 *
 * @category Types and Interfaces
 */
export type OptionalCleanup<T=any> = CleanupFn<T> | Nothing;

/**
 * A cancellable asynchronous operation with automatic resource cleanup.
 *
 * You can add cleanup callbacks to a flow via {@link must}() or its
 * {@link .must}() method.  When the flow is ended or canceled, the callbacks
 * are (synchronously) run in reverse order -- a bit like a delayed and
 * distributed collection of `finally` blocks.
 *
 * Flows implement the Promise interface (then, catch, and finally) so they can
 * be passed to Promise-using APIs or awaited by async functions.  They also
 * implement {@link Yielding}, so you can await their results from a
 * {@link job}() using `yield *`.  They also have {@link Flow.return \.return()}
 * and {@link Flow.throw \.throw()} methods so you can end a flow with a result
 * or error.
 *
 * Most flows, however, are not intended to produce results, and are merely
 * canceled (using {@link Flow.end \.end()} or
 * {@link Flow.restart \.restart()}).
 *
 * Flows can be created and accessed using {@link start}(),
 * {@link detached}.start(), {@link makeFlow}(), {@link job}(), and
 * {@link getFlow}().
 *
 * @category Types and Interfaces
 */
export interface Flow<T=any> extends Yielding<T>, Promise<T> {
    /**
     * The result of the flow (canceled, returned value, or error), or
     * undefined if the flow isn't finished.
     */
    result(): FlowResult<T> | undefined;

    /**
     * Add a cleanup callback to be run when the flow is ended or restarted.
     * (Non-function values are ignored.)  If the flow has already ended,
     * the callback will be invoked asynchronously in the next microtask.
     */
    must(cleanup?: OptionalCleanup<T>): this;

    /**
     * Like {@link Flow.must}, except a function is returned that will *remove*
     * the cleanup function from the flow, if it's still present. (Also, the
     * cleanup function isn't optional.)
     */
    release(cleanup: CleanupFn<T>): () => void;

    /**
     * Start a nested interaction flow using the given function
     *
     * The function is immediately invoked with a callback that can be used
     * to end the flow and release any resources it used. The flow itself is passed
     * as a second argument, and also returned by this method.
     *
     * As with an effect, the action function can register cleanups with
     * {@link must} and/or by returning a cleanup callback.  If the action function
     * throws an error, the flow will be ended, and the error re-thrown.
     *
     * @returns the created {@link Flow}
     */
    start<T=void>(action: (stop: DisposeFn, flow: Flow<T>) => OptionalCleanup): Flow<T>;

    /**
     * Invoke a function with this flow as the active one, so that calling the
     * global {@link must} function will add cleanup callbacks to it,
     * {@link getFlow} will return it, etc.  (Note: signal dependency tracking
     * is disabled for the duration of the call.)
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Wrap a function so this flow will be active when it's called.
     *
     * @param fn The function to wrap
     *
     * @returns A function with the same signature(s), but will have this flow
     * active when called.
     *
     * @remarks Note that if the supplied function has any custom properties,
     * they will *not* be available on the returned function at runtime, even
     * though TypeScript will act as if they are present at compile time.  This
     * is because the only way to copy all overloads of a function signature is
     * to copy the exact type (as TypeScript has no way to generically say,
     * "this a function with all the same overloads, but none of the
     * properties").
     */
    bind<F extends (...args: any[]) => any>(fn: F): F

    /**
     * Release all resources held by the flow.
     *
     * All added cleanup functions will be called in last-in-first-out order,
     * removing them in the process.
     *
     * If any callbacks throw exceptions, they're converted to unhandled promise
     * rejections (so that all of them will be called, even if one throws an
     * error).
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another flow, event handler, etc.
     */
    readonly end: () => void;

    /**
     * Restart this flow - works just like {@link Flow.end}, except that the flow
     * isn't ended, so cleanup callbacks can be added again and won't be invoked
     * until the next restart or the flow is ended.
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another flow, event handler, etc.
     */
    restart(): this;

    /**
     * End the flow with a thrown error, passing an {@link ErrorResult} to the
     * cleanup callbacks.  (Throws an error if the flow is already ended or is
     * currently restarting.)
     */
    throw(err: any): this;

    /**
     * End the flow with a return value, passing a {@link ValueResult} to the
     * cleanup callbacks.  (Throws an error if the flow is already ended or is
     * currently restarting.)
     */
    return(val: T) : this;

}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { Nothing, PlainFunction } from "./types.ts";
import { defer } from "./defer.ts";
import { Request, Yielding, reject } from "./async.ts";
import { chain, isEmpty, pop, push, pushCB } from "./chains.ts";

/**
 * Return the currently-active Flow, or throw an error if none is active.
 *
 * (You can check if a flow is active first using {@link isFlowActive}().)
 *
 * @category Flows
 */
export function getFlow() {
    const {flow} = current;
    if (flow) return flow;
    throw new Error("No flow is currently active");
}

const nullCtx = makeCtx();

class _Flow<T> implements Flow<T> {
    /** @internal */
    static create<T,R>(parent?: Flow<R>, stop?: CleanupFn<R>): Flow<T> {
        const flow = new _Flow<T>;
        if (parent || stop) flow.must(
            (parent || getFlow()).release(stop || flow.end)
        );
        return flow;
    }

    "uneventful/ext": {} = undefined

    result() { return this._done; }

    get [Symbol.toStringTag]() { return "Flow"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs, old = swapCtx(nullCtx);
        while (!isEmpty(cbs)) try { pop(cbs)(res); } catch (e) { Promise.reject(e); }
        swapCtx(old);
    }

    restart() {
        this._end(CancelResult); this._done = undefined; return this;
    }

    _end(res: FlowResult<T>) {
        if (this._done) throw new Error("Flow already ended");
        this._done = res;
        this.end();
        return this;
    }

    throw(err: any) { return this._end(ErrorResult(err)); }
    return(val: T)  { return this._end(ValueResult(val)); }

    then<T1=T, T2=never>(
        onfulfilled?: (value: T) => T1 | PromiseLike<T1>,
        onrejected?: (reason: any) => T2 | PromiseLike<T2>
    ): Promise<T1 | T2> {
        var p = new Promise<T>((res, rej) => this.must(r => {
            // XXX mark error handled
            if (isError(r)) rej(r.err); else if (isValue(r)) res(r.val); else rej(r);
        }))
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
            this.must(res => {
                if (isCancel(res)) reject(req, res); else req(res.op, res.val, res.err);
            });
        }
    }

    start<T=void>(action: (stop: DisposeFn, flow: Flow<T>) => OptionalCleanup): Flow<T> {
        const flow = makeFlow<T>(this);
        try { flow.must(flow.run(action, flow.end, flow)); } catch(e) { flow.end(); throw e; }
        return flow;
    }

    protected constructor() {};

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const flow = this;
        return <F> function () {
            const old = swapCtx(makeCtx(flow));
            try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
        }
    }

    must(cleanup?: OptionalCleanup<T>) {
        if (typeof cleanup === "function") push(this._chain(), cleanup);
        return this;
    }

    release(cleanup: CleanupFn<T>): () => void {
        return pushCB(this._chain(), cleanup);
    }

    protected _done: FlowResult<T> = undefined;
    protected _cbs = chain<CleanupFn<T>>();
    protected _chain() {
        if (this._done && isEmpty(this._cbs)) defer(this.end);
        return this._cbs;
    }
}

/**
 * Add a cleanup function to the active flow. Non-function values are ignored.
 *
 * @category Flows
 */
export function must<T>(cleanup?: OptionalCleanup<T>): Flow<T> {
    return (getFlow() as Flow<T>).must(cleanup);
}

/**
 * Start a nested interaction flow within the currently-active flow.  (Shorthand
 * for {@link getFlow}().{@link Flow.start start}(action).)
 *
 * @returns the created {@link Flow}
 *
 * @category Flows
 */
export function start<T=void>(action: (stop: DisposeFn, flow: Flow<T>) => OptionalCleanup): Flow<T> {
    return getFlow().start(action);
}

/**
 * Is there a currently active flow? (i.e., can you safely use {@link must}(),
 * {@link release}() or {@link getFlow}() right now?)
 *
 * @category Flows
 */
export function isFlowActive() { return !!current.flow; }

/**
 * Like {@link must}(), except a function is returned that will *remove*
 * the cleanup function from the flow, if it's still present. (Also, the cleanup
 * function isn't optional.)
 *
 * @category Flows
 */
export function release(cleanup: CleanupFn): DisposeFn {
    return getFlow().release(cleanup);
}


/**
 * Return a new {@link Flow}.  If *either* a parent parameter or stop function
 * are given, the new flow is linked to the parent.
 *
 * @param parent The parent flow to which the new flow should be attached.
 * Defaults to the currently-active flow if none given (assuming a stop
 * parameter is provided).
 *
 * @param stop The function to call to destroy the nested flow.  Defaults to the
 * {@link Flow.end} method of the new flow if none is given (assuming a parent
 * parameter is provided).
 *
 * @returns A new flow.  The flow is linked/nested if any arguments are given,
 * or a detached (parentless) flow otherwise.
 *
 * @category Flows
 */
export const makeFlow: <T,R=unknown>(parent?: Flow<R>, stop?: CleanupFn<R>) => Flow<T> = _Flow.create;

function noop() {}

/**
 * A {@link FlowResult} that indicates the flow was ended via a return() value.
 *
 * @category Types and Interfaces
 */
export type ValueResult<T> = {op: "next",    val: T,         err: undefined};

/**
 * A {@link FlowResult} that indicates the flow was ended via a throw() or other
 * error.
 *
 * @category Types and Interfaces
 */
export type ErrorResult    = {op: "throw",   val: undefined, err: any};

/**
 * A {@link FlowResult} that indicates the flow was canceled by its creator (via
 * end() or restart()).
 *
 * @category Types and Interfaces
 */
export type CancelResult   = {op: "cancel",  val: undefined, err: undefined};

/**
 * A result passed to a flow's cleanup callbacks
 *
 * @category Types and Interfaces
 */
export type FlowResult<T> = ValueResult<T> | ErrorResult | CancelResult ;

function mkResult<T>(op: "next", val?: T): ValueResult<T>;
function mkResult(op: "throw", val: undefined|null, err: any): ErrorResult;
function mkResult(op: "cancel"): CancelResult;
function mkResult<T>(op: string, val?: T, err?: any): FlowResult<T> {
    return {op, val, err} as FlowResult<T>
}

const CancelResult = mkResult("cancel");

function ValueResult<T>(val: T): ValueResult<T> { return mkResult("next", val); }
function ErrorResult(err: any): ErrorResult { return mkResult("throw", undefined, err); }

/**
 * Returns true if the given result is a {@link CancelResult}.
 *
 * @category Flows
 */
export function isCancel(res: FlowResult<any> | undefined): res is CancelResult {
    return res === CancelResult;
}

/**
 * Returns true if the given result is a {@link ValueResult}.
 *
 * @category Flows
 */
export function isValue<T>(res: FlowResult<T> | undefined): res is ValueResult<T> {
    return res ? res.op === "next" : false;
}

/**
 * Returns true if the given result is a {@link ErrorResult}.
 *
 * @category Flows
 */
export function isError(res: FlowResult<any> | undefined): res is ErrorResult {
    return res ? res.op === "throw" : false;
}

/**
 * A special {@link Flow} with no parents, that can be used to create standalone
 * flows.  detached.start() returns a new detached flow, detached.run() can be used
 * to run code that expects to create a child flow, and detached.bind() can wrap
 * a function to work without a parent flow.
 *
 * (Note that in all cases, a child flow of `detached` must be stopped explicitly, or
 * it may "run" forever, never running its cleanup callbacks.)
 *
 * @category Flows
 */
export const detached = (() => {
    const detached = makeFlow();
    detached.end();
    detached.must = () => { throw new Error("Can't add cleanups to the detached flow"); }
    detached.release = () => noop;
    return detached;
})();
