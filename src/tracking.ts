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
 * Flows can be created and accessed using {@link start}(), {@link root}(),
 * {@link makeFlow}(), and {@link getFlow}().
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
     * Restart a flow - works just like {@link Flow.end}, except that the flow
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

    protected constructor() {};

    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(current.job, this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
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
 * @category Resource Management
 */
export function must(cleanup?: OptionalCleanup) {
    return getFlow().must(cleanup);
}

/**
 * Start an interaction flow. (Like an {@link effect}(), but without any
 * dependency tracking, and the supplied function is run synchronously.)
 *
 * The action function is immediately invoked with a callback that can be used
 * to end the flow and release any resources it used. The flow itself is passed
 * as a second argument, and also returned.
 *
 * As with an effect, the action function can register cleanups with
 * {@link must} and/or by returning a cleanup callback.  If the action function
 * throws an error, the flow will be ended, and the error re-thrown.
 *
 * @returns the created {@link Flow}
 *
 * @category Flows
 */
export function start(action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow {
    return wrapAction(makeFlow(getFlow()), action);
}

/**
 * Start a root (i.e. standalone) interaction flow.  (Like {@link start}(), but
 * the new flow isn't linked to the current flow, meaning this function can be
 * called without a current flow.)
 *
 * The action function is immediately invoked with a callback that can be used
 * to end the flow and release any resources it used. The flow itself is passed
 * as a second argument, and also returned.
 *
 * As with an effect, the action function can register cleanups with
 * {@link must} and/or by returning a cleanup callback.  If the action function
 * throws an error, the flow will be ended, and the error re-thrown.
 *
 * @returns the created {@link Flow}
 *
 * @category Flows
 */
export function root(action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow {
    return wrapAction(makeFlow(), action);
}

function wrapAction(flow: Flow, action: (stop: DisposeFn, flow: Flow) => OptionalCleanup): Flow {
    try { flow.must(flow.run(action, flow.end, flow)); } catch(e) { flow.end(); throw e; }
    return flow;
}

/**
 * Is there a currently active flow? (i.e., can you safely use
 * {@link must}() and {@link release}() right now?)
 *
 * @category Flows
 */
export function isFlowActive() { return !!current.flow; }

/**
 * Like {@link must}(), except a function is returned that will *remove*
 * the cleanup function from the flow, if it's still present. (Also, the cleanup
 * function isn't optional.)
 *
 * @category Resource Management
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
 * or a root/standalone flow otherwise.
 *
 * @category Flows
 */
export const makeFlow: (parent?: Flow, stop?: CleanupFn) => Flow = _Flow.create;


/**
 * Wrap a flow function to create a "detached" (standalone, unnested) version
 *
 * Wrapping a flow factory (like {@link connect}, {@link effect}, {@link job},
 * etc.) with `detached()` creates a standalone version that:
 *
 * 1. doesn't need to run inside another flow, and
 * 2. isn't linked to the active flow even if there is one.
 *
 * So for example `detached(effect)(() => {})` creates a standalone effect that
 * won't be disposed of when the enclosing flow does, and it won't throw an
 * error if there isn't an enclosing flow.
 *
 * @param flowFn Any function that creates a nested flow, but does not register
 * {@link must} functions.
 *
 * @returns A function with the same signature as the input.  Instead of nesting
 * within the current resource tracking context (if any), it will create a
 * standalone (i.e. root) flow.
 *
 * @category Flows
 */
export function detached<T extends (...args: any[]) => any>(flowFn: T): T {
    return <T> function (...args: Parameters<T>) {
        return detachedFlow.run(flowFn, ...args);
    };
}

function noop() {}

// Hacked flow to indicate the detached state
const detachedFlow = makeFlow();
detachedFlow.must = () => { throw new Error("Can't add cleanups in a detached flow"); }
detachedFlow.release = () => { return noop; }
