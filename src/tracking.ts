/**
 * A "flow" is an activity that tracks and releases resources (or runs undo
 * actions) upon termination or restart.
 *
 * By adding `onCleanup()` callbacks to a flow, you can later call its
 * `cleanup()` method to run all of them in reverse order, thereby undoing
 * actions or releasing used resources.
 *
 * The `flow` export lets you create new flows, and perform operations on the
 * "current" flow, if there is one. e.g. `flow.onCleanup(callback)` will add
 * `callback` to the active flow, or throw an error if there is none. (You can
 * use {@link flow.isActive}() to check if there is a currently active flow, or
 * make one active using its `.run()` method.)
 *
 * @category Types and Interfaces
 */
export interface FlowAPI extends ActiveFlow {
    /** Is there a currently active flow? */
    isActive(): boolean;

    /**
     * Get a standalone (root) Flow object
     * @category Flows
     */
    (): Flow;

    /**
     * Create a temporary nested flow -- like an {@link effect}() without any
     * dependency tracking, except that the supplied action is run
     * synchronously.
     */
    (action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn;
}

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
 * The subset of the {@link Flow} interface that's also available on
 * the "current" {@link flow}.
 *
 * @category Types and Interfaces
 */
export interface ActiveFlow {
    /**
     * Add a callback to be run when the flow is released. (Non-function values
     * are ignored.)
     */
    onCleanup(cleanup?: OptionalCleanup): void;

    /**
     * Like {@link onCleanup}(), except a function is returned that will
     * *remove* the cleanup function from the flow, if it's still present.
     * (Also, the cleanup function isn't optional.)
     *
     * (This is mostly used to implement the {@link link}() and {@link nested}()
     * methods, but some custom flow types may also find it useful.)
     */
    addLink(cleanup: CleanupFn): () => void;

    /**
     * Link an "inner" flow to this one, such that the inner flow will
     * remove itself from the outer flow when cleaned up, and the outer
     * flow will clean the inner if cleaned first.
     *
     * Long-lived jobs or event streams often spin off lots of subordinate tasks
     * that will end before the parent does, but which still need to stop when
     * the parent does. Simply adding them to the parent's flow would
     * accumulate a lot of garbage, though: an endless list of cleanup functions
     * to shut down things that were already shut down a long time ago.  So
     * link() and addLink() can be used to create inner flows for subordinate
     * jobs that will unlink themselves from the outer flows, if they finish
     * first.
     *
     * This method is shorthand for `inner.onCleanup(outer.addLink(stop ??
     * inner.cleanup))`. (Similar to {@link ActiveFlow.nested}, except that
     * you supply the inner flow instead of it being created automatically.)
     *
     * (Note that the link is a one-time thing: if you reuse the inner flow
     * after it's been cleaned up, you'll need to link() it again, to re-attach
     * it to the outer flow or attach it to a different one.)
     *
     * @param inner The flow to link.
     * @param stop The function the outer flow should call to clean up the
     * inner; defaults to the inner's `cleanup()` method if not given.
     * @returns The inner flow.
     */
    link(inner: Flow, stop?: CleanupFn): Flow

    /**
     * Create an inner flow that cleans up when the outer flow does, or unlinks
     * itself from the outer flow if the inner flow is cleaned up first.
     *
     * This is shorthand for `inner = root(); outer.link(inner, stop));`. When
     * the inner flow is cleaned up, it will remove its cleanup from the outer
     * flow, preventing defunct cleanup functions from accumulating in the outer
     * flow.
     *
     * (Note that the link is a one-time thing: if you reuse the inner flow
     * after it's been cleaned up, you'll need to use `outer.link(inner, stop?)`
     * to re-attach it to the outer flow or attach it to a different one.)
     *
     * @param stop The function the outer flow should call to clean up the inner
     * flow; defaults to the new flow's `cleanup()` method if not given.
     *
     * @returns A new linked flow
     */
    nested(stop?: CleanupFn): Flow
}

/**
 * A Flow object tracks and releases resources (or runs undo actions) that are
 * used by specific flow implementations (such as effects and jobs).
 *
 * By adding `onCleanup()` callbacks to a flow, you can later call its
 * `cleanup()` method to run all of them in reverse order, thereby undoing
 * actions or releasing of used resources.
 *
 * You can obtain a flow using the {@link flow}() or {@link flow.root}()
 * functions, or use methods of the {@link ActiveFlow}, if there is one.
 *
 * @category Types and Interfaces
 */
export interface Flow extends ActiveFlow {
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

export const flow: FlowAPI = (() => {

    function getFlow() {
        const {flow} = current;
        if (flow) return flow;
        throw new Error("No flow is currently active");
    }

    var freelist: CleanupNode;

    class _flow implements Flow {

        static isActive() { return !!current.flow; }
        static onCleanup(cleanup?: OptionalCleanup) { return getFlow().onCleanup(cleanup); }
        static addLink(cleanup: CleanupFn) { return getFlow().addLink(cleanup); }
        static link(inner: Flow, stop?: CleanupFn) { return getFlow().link(inner, stop); }
        static nested(stop?: CleanupFn) { return getFlow().nested(stop); }

        destroy() {
            this.cleanup();
            recycledFlows.push(this);
        }

        cleanup = () => {
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

        addLink(cleanup: CleanupFn): () => void {
            var rb = this._push(() => { rb = null; cleanup(); });
            return () => { freeCN(rb); rb = null; };
        }

        nested(stop?: CleanupFn): Flow {
            return this.link(flow(), stop);
        }

        link(nested: Flow, stop?: CleanupFn): Flow {
            nested.onCleanup(this.addLink(stop || nested.cleanup));
            return nested;
        }

        protected _next: CleanupNode = undefined;
        protected _push(cb: CleanupFn) {
            let rb = makeCN(cb, current.job, this._next, this as unknown as CleanupNode);
            if (this._next) this._next._prev = rb;
            return this._next = rb;
        }
    }

    function flow(action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn;
    function flow(): Flow;
    function flow(action?: (destroy: DisposeFn) => OptionalCleanup): Flow | DisposeFn {
        return action ? wrapAction(_flow.nested, action) : (recycledFlows.pop() || new _flow);
    }

    flow.prototype = _flow.prototype;
    flow.prototype.constructor = flow;
    return Object.setPrototypeOf(flow, _flow);

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
})();

/**
 * Add a cleanup function to the active flow. Non-function values are ignored.
 *
 * @category Resource Management
 */
export const onCleanup = flow.onCleanup;

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
 * @category Resource Management
 */
export function root(action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn {
    return wrapAction(flow, action);
}

function wrapAction(factory: () => Flow, action: (destroy: DisposeFn) => OptionalCleanup): DisposeFn {
    let flow = factory();
    const destroy = () => { flow?.destroy(); flow = undefined; }
    flow.onCleanup(flow.run(action, destroy));
    return destroy;
}
