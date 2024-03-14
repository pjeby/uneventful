/**
 * A cleanup function is any zero-argument function.  It will always be run in
 * the job context it was registered from.
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
import { CancelResult, ErrorResult, FlowResult, ValueResult, isCancel, isError, isValue } from "./results.ts";
import { Request, Yielding, reject } from "./async.ts";

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

var freelist: CleanupNode;

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

    get [Symbol.toStringTag]() { return "Flow"; }

    end = () => {
        const res = (this._done ||= CancelResult);
        if (!this._next) return;
        const old = swapCtx(nullCtx);
        for (var rb = this._next; rb; ) {
            try { this._next = rb._next; (0,rb._cb)(res); } catch (e) { Promise.reject(e); }
            freeCN(rb);
            rb = this._next;
        }
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
        if (typeof cleanup === "function") this._push(cleanup);
        return this;
    }

    release(cleanup: CleanupFn<T>): () => void {
        var rb = this._push(() => { rb = null; cleanup(); });
        return () => { if (rb && this._next === rb) this._next = rb._next; freeCN(rb); rb = null; };
    }

    protected _done: FlowResult<T> = undefined;
    protected _next: CleanupNode = undefined;
    protected _push(cb: CleanupFn<T>) {
        if (this._done && !this._next) defer(this.end);
        let rb = makeCN(cb, this._next);
        if (this._next) this._next._prev = rb;
        return this._next = rb;
    }
}

type CleanupNode = {
    _next: CleanupNode,
    _prev: CleanupNode,
    _cb: CleanupFn,
}

function makeCN(cb: CleanupFn, next: CleanupNode): CleanupNode {
    if (freelist) {
        let node = freelist;
        freelist = node._next;
        node._next = next;
        node._cb = cb;
        return node;
    }
    return {_next: next, _prev: undefined, _cb: cb}
}

function freeCN(rb: CleanupNode) {
    if (rb) {
        if (rb._next) rb._next._prev = rb._prev;
        if (rb._prev) rb._prev._next = rb._next;
        rb._next = freelist;
        freelist = rb;
        rb._prev = rb._cb = undefined;
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
