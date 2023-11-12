/**
 * A disposal bin is a way to clean up a collection of related resources or undo
 * actions taken by rules, effects, or jobs.
 *
 * By adding "cleanups" -- zero-argument callbacks -- to a disposal bin, you can
 * later call its `cleanup()` method to run all of them in reverse order,
 * thereby undoing actions or disposing of used resources.
 *
 * The `bin` export lets you `.create()` new disposal bins, and perform
 * operations on the "current" bin, if there is one. e.g. `bin.add(callback)`
 * will add `callback` to the active bin, or throw an error if there is none.
 * (You can use `bin.active` to check if there is a currently active bin, or
 * make one active using its `.run()` method.)
 */
interface bin extends ActiveBin {
    /** Is there a currently active bin? */
    readonly active: boolean;

    /**
     * Create a temporary bin, running a function in it and returning a callback
     * that will safely destroy the bin.  (The same callback will be also be
     * passed as the first argument to the function, so the bin can be destroyed
     * either inside or outside the function.)
     *
     * If the called function returns a function, it will be added to the new
     * bin's cleanup callbacks.  If the function throws an error, the bin will
     * be cleaned up, and the error re-thrown.
     *
     * @returns the temporary bin's `destroy` callback
     */
    (action: (destroy: () => void) => OptionalCleanup): () => void;

    /** Return an empty DisposalBin (new or recycled) */
    (): DisposalBin;
}

/** A cleanup function is any zero argument function.  It will always be run in
 * the job context it was registered from. */
export type Cleanup = () => unknown;

/** An optional cleanup parameter or return */
export type OptionalCleanup = Cleanup | Nothing;

/** The subset of the {@link DisposalBin} interface that's also available on the "current" bin */
export interface ActiveBin {
    /**
     * Add a cleanup function to be run when the bin is cleaned up. Non-function
     * values are ignored.
     */
    add(cleanup?: OptionalCleanup): void;

    /** Like add(), except a function is returned that will remove the cleanup
     * function from the bin, if it's still present. */
    addLink(cleanup: Cleanup): () => void;

    /**
     * Link an inner bin to this bin, such that the inner bin will remove itself
     * from the outer bin when cleaned up, and the outer bin will clean the
     * inner if cleaned first.
     *
     * Long-lived jobs or event streams often spin off lots of subordinate tasks
     * that will end before the parent does, but which still need to stop when
     * the parent does. Simply add()ing them to the parent's bin would
     * accumulate a lot of garbage, though: an endless list of cleanup functions
     * to shut down things that were already shut down a long time ago.  So
     * link() and addLink() can be used to create inner bins for subordinate
     * jobs that will unlink themselves from the outer bins, if they finish first.
     *
     * This method is shorthand for `inner.add(outer.addLink(stop ??
     * inner.cleanup))`. (Similar to {@link ActiveBin.nested}, except that you
     * supply the inner bin instead of it being created automatically.)
     *
     * (Note that the link is a one-time thing: if you reuse the inner bin after
     * it's been cleaned up, you'll need to link() it again, to re-attach it to
     * the outer bin or attach it to a different one.)
     *
     * @param inner The bin to link.
     * @param stop The function the outer bin should call to clean up the inner;
     * defaults to the inner's `cleanup()` method if not given.
     * @returns The inner bin.
     */
    link(inner: DisposalBin, stop?: Cleanup): DisposalBin

    /**
     * Create an inner bin that is cleaned up when the outer bin does, or
     * unlinks itself from the outer bin if the inner bin is cleaned up first.
     *
     * This is shorthand for `inner = bin.create(); outer.link(inner, stop));`.
     * When the inner bin is cleaned up, it will remove its cleanup from the
     * outer bin, preventing defunct cleanup functions from accumulating in the
     * outer bin.
     *
     * (Note that the link is a one-time thing: if you reuse the inner bin after
     * it's been cleaned up, you'll need to use `outer.link(inner, stop?)` to
     * re-attach it to the outer bin or attach it to a different one.)
     *
     * @param stop The function the outer bin should call to clean up the inner
     * bin; defaults to the new bin's `cleanup()` method if not given.
     * @returns A new linked bin
     */
    nested(stop?: Cleanup): DisposalBin
}

export interface DisposalBin extends ActiveBin {
    /**
     * Call all the added cleanup functions, removing them in the process
     *
     * If any callbacks throw exceptions, they're converted to unhandled promise
     * rejections (so that all of them will be called, even if one throws an
     * error).
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another bin, event handler, etc.
     */
    readonly cleanup: () => void;

    /**
     * Invoke a function with this bin as the active one, so that `bin.add()`
     * will add things to it, `bin.nested()` will fork it, and so on.
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Deallocate the bin and recycle it for future use
     *
     * Do not use this method unless you can guarantee there are no outstanding
     * references to the bin, or else Bad Things Will Happen.
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another bin, event handler, etc.
     */
    readonly destroy: () => void;
}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { Job, Nothing, PlainFunction } from "./types.ts";

export const bin: bin = (() => {

    function getBin() {
        const {bin} = current;
        if (bin) return bin;
        throw new Error("No disposal bin is currently active");
    }

    const recycledBins = [] as DisposalBin[];
    var freelist: CleanupNode;

    class _bin implements DisposalBin {

        static get active() { return !!current.bin; }
        static add(cleanup?: OptionalCleanup) { return getBin().add(cleanup); }
        static addLink(cleanup: Cleanup) { return getBin().addLink(cleanup); }
        static link(inner: DisposalBin, stop?: Cleanup) { return getBin().link(inner, stop); }
        static nested(stop?: Cleanup) { return getBin().nested(stop); }

        destroy = () => {
            this.cleanup();
            recycledBins.push(this);
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

        add(cleanup?: OptionalCleanup) {
            if (typeof cleanup === "function") this._push(cleanup);
        }

        addLink(cleanup: Cleanup): () => void {
            var rb = this._push(() => { rb = null; cleanup(); });
            return () => { freeCN(rb); rb = null; };
        }

        nested(stop?: Cleanup): DisposalBin {
            return this.link(bin(), stop);
        }

        link(nested: DisposalBin, stop?: Cleanup): DisposalBin {
            nested.add(this.addLink(stop || nested.cleanup));
            return nested;
        }

        protected _next: CleanupNode = undefined;
        protected _push(cb: Cleanup) {
            let rb = makeCN(cb, current.job, this._next, this as unknown as CleanupNode);
            if (this._next) this._next._prev = rb;
            return this._next = rb;
        }
    }

    function bin(action: (destroy: () => void) => OptionalCleanup): () => void;
    function bin(): DisposalBin;
    function bin(action?: (destroy: () => void) => OptionalCleanup) {
        if (this instanceof bin) throw new Error("Use bin() without new")
        const b = recycledBins.pop() || new _bin;
        if (typeof action === "function") { b.add(b.run(action, b.destroy)); return b.destroy; }
        return b;
    }
    bin.prototype = _bin.prototype;
    bin.prototype.constructor = bin;
    return Object.setPrototypeOf(bin, _bin);

    type CleanupNode = {
        _next: CleanupNode,
        _prev: CleanupNode,
        _cb: Cleanup,
        _job: Job<any>
    }

    function makeCN(cb: Cleanup, job: Job<any>, next: CleanupNode, prev: CleanupNode): CleanupNode {
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

export const cleanup = bin.add;
