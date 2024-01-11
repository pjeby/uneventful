/**
 * A cleanup function is any zero-argument function.  It will always be run in
 * the job context it was registered from.
 *
 * @category Types and Interfaces
 */
export type CleanupFn = () => unknown;

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
export type OptionalCleanup = CleanupFn | Nothing;

/**
 * A Flow object tracks and releases resources (or runs undo actions) that are
 * used within an operation or task.
 *
 * By adding {@link must}() callbacks to a flow, you can later call its
 * {@link Flow.end end}() method to run all of them in reverse order, thereby
 * cleaning up after the action -- a bit like a delayed and distributed
 * `finally` block.
 *
 * Flows can be created and accessed using {@link start}(),
 * {@link detached}.start(), {@link makeFlow}(), and {@link getFlow}().
 *
 * @category Types and Interfaces
 */
export interface Flow {
    /**
     * Add a cleanup callback to be run when the flow is ended or restarted.
     * (Non-function values are ignored.)  If the flow has already ended,
     * the callback will be invoked asynchronously in the next microtask.
     */
    must(cleanup?: OptionalCleanup): void;

    /**
     * Like {@link Flow.must}, except a function is returned that will *remove*
     * the cleanup function from the flow, if it's still present. (Also, the
     * cleanup function isn't optional.)
     */
    release(cleanup: CleanupFn): () => void;

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
    start(action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow;

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
    readonly restart: () => void;

}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { Nothing, PlainFunction } from "./types.ts";
import type { Job } from "./jobs.ts";
import { defer } from "./defer.ts";

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

class _Flow implements Flow {
    /** @internal */
    static create(parent?: Flow, stop?: CleanupFn) {
        const flow = new _Flow;
        if (parent || stop) flow.must(
            (parent || getFlow()).release(stop || flow.end)
        );
        return flow;
    }

    end = () => {
        this._done = true;
        const old = swapCtx(makeCtx());
        for (var rb = this._next; rb; ) {
            try { current.job = rb._job; (0,rb._cb)(); } catch (e) { Promise.reject(e); }
            if (this._next === rb) this._next = rb._next;
            freeCN(rb);
            rb = this._next;
        }
        freeCtx(swapCtx(old));
    }

    restart() {
        if (this._done) throw new Error("Can't restart ended flow");
        this.end(); this._done = false;
    }

    start(action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow {
        const flow = makeFlow(this);
        try { flow.must(flow.run(action, flow.end, flow)); } catch(e) { flow.end(); throw e; }
        return flow;
    }

    protected constructor() {};

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(current.job, this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const flow = this;
        return <F> function () {
            const old = swapCtx(makeCtx(current.job, flow));
            try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
        }
    }

    must(cleanup?: OptionalCleanup) {
        if (typeof cleanup === "function") this._push(cleanup);
    }

    release(cleanup: CleanupFn): () => void {
        var rb = this._push(() => { rb = null; cleanup(); });
        return () => { if (rb && this._next === rb) this._next = rb._next; freeCN(rb); rb = null; };
    }

    protected _done = false;
    protected _next: CleanupNode = undefined;
    protected _push(cb: CleanupFn) {
        if (this._done) defer(this.end);
        let rb = makeCN(cb, current.job, this._next);
        if (this._next) this._next._prev = rb;
        return this._next = rb;
    }
}

type CleanupNode = {
    _next: CleanupNode,
    _prev: CleanupNode,
    _cb: CleanupFn,
    _job: Job<any>
}

function makeCN(cb: CleanupFn, job: Job<any>, next: CleanupNode): CleanupNode {
    if (freelist) {
        let node = freelist;
        freelist = node._next;
        node._next = next;
        node._cb = cb;
        node._job = job;
        return node;
    }
    return {_next: next, _prev: undefined, _cb: cb, _job: job}
}

function freeCN(rb: CleanupNode) {
    if (rb) {
        if (rb._next) rb._next._prev = rb._prev;
        if (rb._prev) rb._prev._next = rb._next;
        rb._next = freelist;
        freelist = rb;
        rb._prev = rb._cb = rb._job = undefined;
    }
}

/**
 * Add a cleanup function to the active flow. Non-function values are ignored.
 *
 * @category Flows
 */
export function must(cleanup?: OptionalCleanup) {
    return getFlow().must(cleanup);
}

/**
 * Start a nested interaction flow within the currently-active flow.  (Shorthand
 * for {@link getFlow}().{@link Flow.start start}(action).)
 *
 * @returns the created {@link Flow}
 *
 * @category Flows
 */
export function start(action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow {
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
export const makeFlow: (parent?: Flow, stop?: CleanupFn) => Flow = _Flow.create;

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
