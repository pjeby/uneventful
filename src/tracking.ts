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

export interface Flow {
    /**
     * Add a callback to be run when the flow is cleaned up. (Non-function
     * values are ignored.)
     */
    onCleanup(cleanup?: OptionalCleanup): void;

    /**
     * Like {@link Flow.onCleanup onCleanup()}, except a function is
     * returned that will *remove* the cleanup function from the flow, if it's
     * still present. (Also, the cleanup function isn't optional.)
     */
    linkedCleanup(cleanup: CleanupFn): () => void;

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
    readonly cleanup: () => void;

    /**
     * Invoke a function with this flow as the active one, so that
     * `flow.onCleanup()` will add cleanups to it, `flow.nested()` will
     * create a flow nested in it, and so on.
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Release all resources, deallocate the flow object, and recycle it for
     * future use
     *
     * Do not use this method unless you can *guarantee* there are no
     * outstanding references to the flow, or else Bad Things Will Happen.
     */
    destroy(): void;
}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { Job, Nothing, PlainFunction } from "./types.ts";

const recycledFlows = [] as Flow[];

    function getFlow() {
        const {flow} = current;
        if (flow) return flow;
        throw new Error("No flow is currently active");
    }

    var freelist: CleanupNode;

/**
 * A Flow object tracks and releases resources (or runs undo actions) that are
 * used by specific flow implementations (such as effects and jobs).
 *
 * By adding `onCleanup()` callbacks to a flow, you can later call its
 * `cleanup()` method to run all of them in reverse order, thereby undoing
 * actions or releasing of used resources.
 *
 * You can obtain/create a flow using {@link makeFlow}().
 *
 * @category Types and Interfaces
 */
export class Flow {
        /** @internal */
        static create(parent?: Flow, stop?: CleanupFn) {
            const flow = recycledFlows.shift() || new Flow;
            if (parent || stop) flow.onCleanup(
                (parent || current.flow).linkedCleanup(stop || flow.cleanup)
            );
            return flow;
        }

        protected constructor() {};

        destroy() {
            this.cleanup();
            recycledFlows.push(this);
        }

        readonly cleanup = () => {
            const old = swapCtx(makeCtx());
            for (var rb = this._next; rb; freeCN(rb), rb = this._next) {
                try { current.job = rb._job; (0,rb._cb)(); } catch (e) { Promise.reject(e); }
            }
            freeCtx(swapCtx(old));
        }

        run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F> {
            const old = swapCtx(makeCtx(current.job, this));
            try {
                return fn.apply(null, args);
            } catch(e) {
                this.cleanup(); throw e;
            } finally { freeCtx(swapCtx(old)); }
        }

        onCleanup(cleanup?: OptionalCleanup) {
            if (typeof cleanup === "function") this._push(cleanup);
        }

        linkedCleanup(cleanup: CleanupFn): () => void {
            var rb = this._push(() => { rb = null; cleanup(); });
            return () => { freeCN(rb); rb = null; };
        }

        protected _next: CleanupNode = undefined;
        protected _push(cb: CleanupFn) {
            let rb = makeCN(cb, current.job, this._next, this as unknown as CleanupNode);
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

    function makeCN(cb: CleanupFn, job: Job<any>, next: CleanupNode, prev: CleanupNode): CleanupNode {
        if (freelist) {
            let node = freelist;
            freelist = node._next;
            node._next = next;
            node._prev = prev;
            node._cb = cb;
            node._job = job;
            return node;
        }
        return {_next: next, _prev: prev, _cb: cb, _job: job}
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
export function onCleanup(cleanup?: OptionalCleanup) {
    return getFlow().onCleanup(cleanup);
}

/**
 * Create a temporary nested flow -- like an {@link effect}() without any
 * dependency tracking, except that the supplied action is run synchronously.
 *
 * The action function is invoked with a callback that can be used to destroy
 * the flow and release any resources it used. (The same callback is also
 * returned from the `flow()` call)
 *
 * As with an effect, the action function can register cleanups with
 * {@link onCleanup} and/or by returning a cleanup callback.
 *
 * @category Flows
 */
export function flow(action: (stop: DisposeFn) => OptionalCleanup): DisposeFn {
    return wrapAction(makeFlow(getFlow()), action);
}

/**
 * Create a temporary, standalone flow, running a function in it and returning a
 * callback that will safely dispose of the flow and its resources.  (The same
 * callback will be also be passed as the first argument to the function, so the
 * flow can be destroyed from either inside or outside the function.)
 *
 * If the called function returns a function, it will be added to the new flow's
 * cleanup callbacks.  If the function throws an error, the flow will be cleaned
 * up, and the error re-thrown.
 *
 * @returns a callback that will destroy the temporary flow
 *
 * @category Flows
 */
export function root(action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn {
    return wrapAction(makeFlow(), action);
}

function wrapAction(flow: Flow, action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn {
    function destroy() { flow?.destroy(); flow = undefined; }
    flow.onCleanup(flow.run(action, destroy));
    return destroy;
}

/**
 * Is there a currently active flow? (i.e., can you safely use
 * {@link onCleanup}() and {@link linkedCleanup}() right now?)
 *
 * @category Flows
 */
export function isFlowActive() { return !!current.flow; }

/**
 * Like {@link onCleanup}(), except a function is returned that will *remove*
 * the cleanup function from the flow, if it's still present. (Also, the cleanup
 * function isn't optional.)
 *
 * @category Resource Management
 */
export function linkedCleanup(cleanup: CleanupFn): DisposeFn {
    return getFlow().linkedCleanup(cleanup);
}


/**
 * Return a new or recycled Flow instance.  If *either* a parent parameter or
 * stop function are given, a nested flow is returned.
 *
 * @param parent The parent flow to which the new flow should be attached.
 * Defaults to the currently-active flow if none given (assuming a stop
 * parameter is provided).
 *
 * @param stop The function to call to destroy the nested flow.  Defaults to the
 * {@link Flow.cleanup} method of the new flow if none is given (assuming a
 * parent parameter is provided).
 *
 * @returns A nested Flow instance is returned if any arguments are given, or a
 * root/standalone Flow otherwise.
 *
 * @category Flows
 */
export const makeFlow = Flow.create;


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
 * {@link onCleanup} functions.
 *
 * @returns A function with the same signature as the input.  Instead of nesting
 * within the current resource tracking context (if any), it will create a
 * standalone (i.e. root) flow.
 *
 * @category Resource Management
 */
export function detached<T extends (...args: any[]) => any>(flowFn: T): T {
    return <T> function (...args) {
        const old = current.flow;
        current.flow = detachedFlow as Flow;
        try { return flowFn.apply(this, args); } finally { current.flow = old; }
    };
}

function noop() {}

const detachedFlow: Pick<Flow, "onCleanup" | "linkedCleanup"> = {
    onCleanup(_cleanup?: OptionalCleanup) {
        throw new Error("Can't add cleanups in a detached flow");
    },
    linkedCleanup(_cleanup: CleanupFn): () => void { return noop; },
};
