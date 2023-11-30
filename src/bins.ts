/**
 * A resource tracker tracks and releases resources (or runs undo actions) that
 * are used by flows (such as effects and jobs) or other units of work.
 *
 * By adding `onCleanup()` callbacks to a tracker, you can later call its
 * `cleanup()` method to run all of them in reverse order, thereby undoing
 * actions or releasing used resources.
 *
 * The `tracker` export lets you create new trackers, and perform operations on
 * the "current" tracker, if there is one. e.g. `tracker.add(callback)` will add
 * `callback` to the active tracker, or throw an error if there is none. (You
 * can use `tracker.active` to check if there is a currently active tracker, or
 * make one active using its `.run()` method.)
 *
 * @category Resource Management
 */
interface TrackerAPI extends ActiveTracker {
    /** Is there a currently active tracker? */
    active(): boolean;

    /** Return an empty ResourceTracker (new or recycled) */
    (): ResourceTracker;
}

/**
 * A cleanup function is any zero-argument function.  It will always be run in
 * the job context it was registered from.
 *
 * @category Resource Management
 */
export type CleanupFn = () => unknown;

/**
 * An optional cleanup parameter or return.
 *
 * @category Resource Management
 */
export type OptionalCleanup = CleanupFn | Nothing;

/**
 * The subset of the {@link ResourceTracker} interface that's also available on
 * the "current" tracker.
 *
 * @category Resource Management
 */
export interface ActiveTracker {
    /**
     * Add a callback to be run when the tracker is released. (Non-function
     * values are ignored.)
     */
    onCleanup(cleanup?: OptionalCleanup): void;

    /** Like onCleanup(), except a function is returned that will remove the cleanup
     * function from the tracker, if it's still present. */
    addLink(cleanup: CleanupFn): () => void;

    /**
     * Link an "inner" tracker to this one, such that the inner tracker will
     * remove itself from the outer tracker when cleaned up, and the outer
     * tracker will clean the inner if cleaned first.
     *
     * Long-lived jobs or event streams often spin off lots of subordinate tasks
     * that will end before the parent does, but which still need to stop when
     * the parent does. Simply adding them to the parent's tracker would
     * accumulate a lot of garbage, though: an endless list of cleanup functions
     * to shut down things that were already shut down a long time ago.  So
     * link() and addLink() can be used to create inner trackers for subordinate
     * jobs that will unlink themselves from the outer trackers, if they finish
     * first.
     *
     * This method is shorthand for `inner.onCleanup(outer.addLink(stop ??
     * inner.cleanup))`. (Similar to {@link ActiveTracker.nested}, except that
     * you supply the inner tracker instead of it being created automatically.)
     *
     * (Note that the link is a one-time thing: if you reuse the inner tracker
     * after it's been cleaned up, you'll need to link() it again, to re-attach
     * it to the outer tracker or attach it to a different one.)
     *
     * @param inner The tracker to link.
     * @param stop The function the outer tracker should call to clean up the
     * inner; defaults to the inner's `cleanup()` method if not given.
     * @returns The inner tracker.
     */
    link(inner: ResourceTracker, stop?: CleanupFn): ResourceTracker

    /**
     * Create an inner tracker that cleans up when the outer tracker does,
     * or unlinks itself from the outer tracker if the inner tracker is cleaned
     * up first.
     *
     * This is shorthand for `inner = tracker(); outer.link(inner, stop));`.
     * When the inner tracker is cleaned up, it will remove its cleanup from the
     * outer tracker, preventing defunct cleanup functions from accumulating in
     * the outer tracker.
     *
     * (Note that the link is a one-time thing: if you reuse the inner tracker
     * after it's been cleaned up, you'll need to use `outer.link(inner, stop?)`
     * to re-attach it to the outer tracker or attach it to a different one.)
     *
     * @param stop The function the outer tracker should call to clean up the
     * inner tracker; defaults to the new tracker's `cleanup()` method if not
     * given.
     *
     * @returns A new linked tracker
     */
    nested(stop?: CleanupFn): ResourceTracker
}

/**
 * A resource tracker tracks and releases resources (or runs undo actions) that
 * are used by flows (such as effects and jobs) or other units of work.
 *
 * By adding `onCleanup()` callbacks to a tracker, you can later call its
 * `release()` method to run all of them in reverse order, thereby undoing
 * actions or releasing of used resources.
 *
 * @category Resource Management
 */
export interface ResourceTracker extends ActiveTracker {
    /**
     * Release all resources held by the tracker.
     *
     * All added cleanup functions will be called in last-in-first-out order,
     * removing them in the process.
     *
     * If any callbacks throw exceptions, they're converted to unhandled promise
     * rejections (so that all of them will be called, even if one throws an
     * error).
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another tracker, event handler, etc.
     */
    readonly cleanup: () => void;

    /**
     * Invoke a function with this tracker as the active one, so that
     * `tracker.add()` will add things to it, `tracker.nested()` will fork it,
     * and so on.
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Release all resources, deallocate the tracker, and recycle it for future use
     *
     * Do not use this method unless you can *guarantee* there are no outstanding
     * references to the tracker, or else Bad Things Will Happen.
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another tracker, event handler, etc.
     */
    readonly destroy: () => void;
}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { Job, Nothing, PlainFunction } from "./types.ts";

const recycledTrackers = [] as ResourceTracker[];

/**
 * Create a {@link ResourceTracker} or manage the {@link ActiveTracker}.
 *
 * The {@link tracker} function object is also an {@link ActiveTracker}
 * instance, with its methods applying to the currently active tracker.  (If
 * there is no active tracker, an error will be thrown when you try to use those
 * methods.)
 *
 * You can check if there is an active tracker by calling
 * {@link tracker.active}().
 *
 * @category Resource Management
 */
export const tracker: TrackerAPI = (() => {

    function getTracker() {
        const {tracker: bin} = current;
        if (bin) return bin;
        throw new Error("No resource tracker is currently active");
    }

    var freelist: CleanupNode;

    class _tracker implements ResourceTracker {

        static active() { return !!current.tracker; }
        static onCleanup(cleanup?: OptionalCleanup) { return getTracker().onCleanup(cleanup); }
        static addLink(cleanup: CleanupFn) { return getTracker().addLink(cleanup); }
        static link(inner: ResourceTracker, stop?: CleanupFn) { return getTracker().link(inner, stop); }
        static nested(stop?: CleanupFn) { return getTracker().nested(stop); }

        destroy = () => {
            this.cleanup();
            recycledTrackers.push(this);
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

        nested(stop?: CleanupFn): ResourceTracker {
            return this.link(tracker(), stop);
        }

        link(nested: ResourceTracker, stop?: CleanupFn): ResourceTracker {
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

    function tracker(): ResourceTracker {
        if (this instanceof tracker) throw new Error("Use tracker() without new")
        return recycledTrackers.pop() || new _tracker;
    }

    tracker.prototype = _tracker.prototype;
    tracker.prototype.constructor = tracker;
    return Object.setPrototypeOf(tracker, _tracker);

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
 * Add a cleanup function to the active tracker. Non-function values are
 * ignored.
 *
 * @category Resource Management
 */
export const onCleanup = tracker.onCleanup;

/**
 * Create a temporary tracker, running a function in it and returning a
 * callback that will safely dispose of the tracker and its resources.  (The
 * same callback will be also be passed as the first argument to the
 * function, so the tracker can be destroyed from either inside or outside the
 * function.)
 *
 * If the called function returns a function, it will be added to the new
 * tracker's cleanup callbacks.  If the function throws an error, the
 * tracker will be cleaned up, and the error re-thrown.
 *
 * @returns the temporary tracker's `dispose` callback
 *
 * @category Resource Management
 */
export function track(action: (destroy: () => void) => OptionalCleanup): () => void {
    const t = tracker();
    t.onCleanup(t.run(action, t.destroy));
    return t.destroy;
}
