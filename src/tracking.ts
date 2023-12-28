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
 * By adding {@link onEnd}() callbacks to a flow, you can later call its
 * {@link Flow.end end}() method to run all of them in reverse order, thereby
 * cleaning up after the action -- a bit like a delayed and distributed
 * `finally` block.
 *
 * Flows are created using {@link runner}(), which returns a flow plus functions
 * for ending or restarting the flow.
 *
 * @category Types and Interfaces
 */
export interface Flow {
    /**
     * Add a cleanup callback to be run when the flow is ended or restarted.
     * (Non-function values are ignored.)  If the flow has already ended,
     * the callback will be invoked asynchronously in the next microtask.
     */
    onEnd(cleanup?: OptionalCleanup): void;

    /**
     * Like {@link Flow.onEnd}, except a function is returned that will *remove*
     * the cleanup function from the flow, if it's still present. (Also, the
     * cleanup function isn't optional.)
     */
    linkedEnd(cleanup: CleanupFn): () => void;

    /**
     * Invoke a function with this flow as the active one, so that calling the
     * global {@link onEnd} function will add cleanup callbacks to it,
     * {@link getFlow} will return it, etc.
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>
}

/**
 * A Flow's runtime controller - used to end or restart a flow
 *
 * @category Types and Interfaces
 */
export interface Runner {
    /** The flow this runner controls **/
    flow: Flow

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
     * Restart a flow - works just like {@link Runner.end}, except that the flow
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

function endFlow(this: _Flow) {
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

class _Flow implements Flow {
    /** @internal */
    static runner(parent?: Flow, stop?: CleanupFn) {
        const flow = new _Flow, end = endFlow.bind(flow);
        if (parent || stop) flow.onEnd(
            (parent || getFlow()).linkedEnd(stop || end)
        );
        return {flow, end, restart() {
             if (flow._done) throw new Error("Can't restart ended flow");
             end(); flow._done = false;
        }};
    }

    protected constructor() {};

    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(current.job, this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
    }

    onEnd(cleanup?: OptionalCleanup) {
        if (typeof cleanup === "function") this._push(cleanup);
    }

    linkedEnd(cleanup: CleanupFn): () => void {
        var rb = this._push(() => { rb = null; cleanup(); });
        return () => { if (rb && this._next === rb) this._next = rb._next; freeCN(rb); rb = null; };
    }

    protected _done = false;
    protected _next: CleanupNode = undefined;
    protected _push(cb: CleanupFn) {
        if (this._done) defer(endFlow.bind(this));
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
export function onEnd(cleanup?: OptionalCleanup) {
    return getFlow().onEnd(cleanup);
}

/**
 * Create a single-use nested flow. (Like an {@link effect}(), but without any
 * dependency tracking, and the supplied function is run synchronously.)
 *
 * The action function is immediately invoked with a callback that can be used
 * to end the flow and release any resources it used. (The same callback is
 * also returned from the `flow()` call.)
 *
 * As with an effect, the action function can register cleanups with
 * {@link onEnd} and/or by returning a cleanup callback.
 *
 * @returns a callback that will end the flow
 *
 * @category Flows
 */
export function flow(action: (stop: DisposeFn) => OptionalCleanup): DisposeFn {
    return wrapAction(runner(getFlow()), action);
}

/**
 * Create a temporary, standalone flow, running a function in it and returning a
 * callback that will safely dispose of the flow and its resources.  (The same
 * callback will be also be passed as the first argument to the function, so the
 * flow can be ended from either inside or outside the function.)
 *
 * If the called function returns a function, it will be added to the new flow's
 * cleanup callbacks.  If the function throws an error, the flow will be cleaned
 * up, and the error re-thrown.
 *
 * @returns a callback that will end the flow
 *
 * @category Flows
 */
export function root(action: (stop: DisposeFn) => OptionalCleanup): DisposeFn {
    return wrapAction(runner(), action);
}

function wrapAction(runner: Runner, action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn {
    try { runner.flow.onEnd(runner.flow.run(action, runner.end)); } catch(e) { runner.end(); throw e; }
    return runner.end;
}

/**
 * Is there a currently active flow? (i.e., can you safely use
 * {@link onEnd}() and {@link linkedEnd}() right now?)
 *
 * @category Flows
 */
export function isFlowActive() { return !!current.flow; }

/**
 * Like {@link onEnd}(), except a function is returned that will *remove*
 * the cleanup function from the flow, if it's still present. (Also, the cleanup
 * function isn't optional.)
 *
 * @category Resource Management
 */
export function linkedEnd(cleanup: CleanupFn): DisposeFn {
    return getFlow().linkedEnd(cleanup);
}


/**
 * Return a new {@link Runner}.  If *either* a parent parameter or stop function
 * are given, the new runner's flow is linked to the parent.
 *
 * @param parent The parent flow to which the new flow should be attached.
 * Defaults to the currently-active flow if none given (assuming a stop
 * parameter is provided).
 *
 * @param stop The function to call to destroy the nested flow.  Defaults to the
 * {@link Runner.end} method of the new runner if none is given (assuming a
 * parent parameter is provided).
 *
 * @returns A runner for a new flow.  The flow is linked/nested if any arguments
 * are given, or a root/standalone flow otherwise.
 *
 * @category Flows
 */
export const runner: (parent?: Flow, stop?: CleanupFn) => Runner = _Flow.runner;


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
 * {@link onEnd} functions.
 *
 * @returns A function with the same signature as the input.  Instead of nesting
 * within the current resource tracking context (if any), it will create a
 * standalone (i.e. root) flow.
 *
 * @category Flows
 */
export function detached<T extends (...args: any[]) => any>(flowFn: T): T {
    return <T> function (...args) {
        const old = current.flow;
        current.flow = detachedFlow;
        try { return flowFn.apply(this, args); } finally { current.flow = old; }
    };
}

function noop() {}

// Hacked flow to indicate the detached state
const detachedFlow = runner().flow;
detachedFlow.onEnd = () => { throw new Error("Can't add cleanups in a detached flow"); }
detachedFlow.linkedEnd = () => { return noop; }
