import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { defer } from "./defer.ts";
import { ActiveFlow, DisposeFn, OptionalCleanup, flow } from "./tracking.ts";

/**
 * Error indicating an effect has attempted to write a value it indirectly
 * depends on, or which has already been read by another effect in the current
 * batch. (Also thrown when a cached function attempts to write a value at all,
 * directly or inidirectly.)
 *
 * @category Errors
 */
export class WriteConflict extends Error {}

/**
 * Error indicating an effect has attempted to write a value it directly depends
 * on, or a cached function has called itself, directly or indirectly.
 *
 * @category Errors
 */
export class CircularDependency extends Error {}

var timestamp = 1;
var currentEffect: Cell;
var currentQueue: EffectScheduler;

/**
 * A queue for effects to run during a particular kind of period, such as
 * microtasks or animation frames.  (Can only be obtained or created via
 * {@link effect.scheduler}().)
 *
 * @category Types and Interfaces
 */
export class EffectScheduler {
    protected _queue = new Set<Cell>;
    protected _isScheduled = false;

    /** Is this scheduler currently flushing effects? */
    isRunning() { return currentQueue === this; }

    /**
     * Is this scheduler currently empty? (i.e. no pending effects)
     *
     * Note: "pending" effects are ones with at least one changed ancestor
     * dependency; this doesn't mean they will actually *do* anything,
     * since intermediate cached() function results might end up unchanged.
     */
    isEmpty() { return !this._queue.size; }

    protected static cache = new WeakMap<Function, EffectScheduler>();

    /** @internal */
    static for(scheduleFn: (cb: () => unknown) => unknown) {
        this.cache.has(scheduleFn) || this.cache.set(scheduleFn, new this(scheduleFn));
        return this.cache.get(scheduleFn);
    }

    protected constructor(protected readonly scheduleFn: (cb: () => unknown) => unknown) {}

    /** @internal */
    add(e: Cell) {
        this._queue.size || this.schedule();
        this._queue.add(e);
    }

    /** @internal */
    delete(e: Cell) {
        this._queue.delete(e);
    }

    protected schedule = () => {
        if (this._isScheduled || currentQueue === this) return;
        this._isScheduled = true;
        this.scheduleFn(this.runScheduled);
    }

    protected runScheduled = () => {
        this._isScheduled = false;
        this.flush();
    }

    /** Run all pending effects. */
    flush = () => {
        // already running? skip it
        if (currentQueue === this) return;
        const {_queue} = this;
        // nothing to do? skip it
        if (!_queue.size) return;
        // another queue is running? reschedule for later
        if (currentQueue) return this.schedule();
        currentQueue = this;
        try {
            // run effects marked dirty by value changes
            for(currentEffect of _queue) {
                currentEffect.catchUp();
                _queue.delete(currentEffect);
            }
        } finally {
            currentQueue = currentEffect = undefined;
            // schedule again if we're stopping early due to error
            if (_queue.size) this.schedule();
        }
    }

    /**
     * Subscribe a function to run every time certain values change.
     *
     * The function is run asynchronously, first after being created, then again
     * after there are changes in any of the values or cached functions it read
     * during its previous run.
     *
     * The created subscription is tied to the currently-active flow.  So when
     * that flow is ended or restarted, the effect will be terminated
     * automatically.  You can also terminate it early by calling the "stop"
     * function that is both passed to the effect function and returned by
     * `effect()`.
     *
     * Note: this function will throw an error if called without an active flow.
     * If you need a standalone effect, use {@link effect.root} (or
     * {@link EffectScheduler.root effect.scheduler().root()}) instead.
     *
     * @param fn The function that will be run each time its dependencies
     * change.  The function will be run in a fresh flow each time, with any
     * resources used by the previous run being cleaned up.  The function is
     * passed a single argument: a function that can be called to terminate the
     * effect.   The function should return a cleanup function or void.
     *
     * @returns A function that can be called to terminate the effect.
     */
    effect = (fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn => {
        return Cell.mkEffect(fn, flow, this);
    };

    /**
     * Create a standalone ("root") effect that won't be tied to the current
     * flow (and thus doesn't *need* an enclosing flow).
     *
     * Just like a plain {@link effect}() or {@link EffectScheduler.effect}(),
     * except that the effect is *not* tied to the current flow, and will
     * therefore remain active until the "stop" function or dispose callback is
     * called, even if the enclosing flow is ended or restarted.
     */
    root = (fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn => {
        return Cell.mkEffect(fn, undefined, this);
    };
}

const defaultQueue = EffectScheduler.for(defer);

/**
 * Synchronously run pending effects from the default scheduler.
 *
 * Equivalent to calling {@link EffectScheduler.flush .flush()} on
 * {@link effect.scheduler}().
 *
 * Note that you should normally only need to call this when you need
 * side-effects to occur within a specific synchronous timeframe, e.g. if
 * effects need to be able to cancel a synchronous event or continue an
 * IndexedDB transaction.  (You can also define effects to run in a specific
 * timeframe by creating a {@link EffectScheduler} for them, via
 * {@link effect.scheduler}().)
 *
 * @category Signals
 */
export const runEffects = defaultQueue.flush


const dirtyStack: Cell[] = [];

function markDependentsDirty(cell: Cell) {
    // We don't set validThrough here because that's how we tell the cell's been read/depended on
    const latestSource = cell.lastChanged = cell.latestSource = timestamp;
    for(; cell; cell = dirtyStack.pop()) {
        for (let sub=cell.subscribers; sub; sub = sub.nT) {
            const tgt = sub.tgt;
            if (tgt.latestSource >= latestSource) continue;
            tgt.latestSource = latestSource;
            if (tgt.flags & Is.Effect) (tgt.value as EffectScheduler).add(tgt);
            if (tgt.subscribers) dirtyStack.push(tgt);
        }
    }
}


const enum Is {
    Effect = 1 << 0,
    Lazy   = 1 << 2,
    Dead   = 1 << 3,
    Error  = 1 << 4,
    Running = 1 << 5,
    Computed = Effect | Lazy,
}

type Subscription = {
    /** Source of the subscription */
    src: Cell
    nS: Subscription,
    pS: Subscription,

    /** Subscriber */
    tgt: Cell
    nT: Subscription,
    pT: Subscription,

    ts: number,

    /* stack for active subscriptions on sources */
    old: Subscription
}

var freesubs: Subscription;

function mksub(source: Cell, target: Cell) {
    let sub: Subscription = freesubs;
    if (sub) {
        freesubs = sub.old;
        sub.src = source; sub.nS = undefined; sub.pS = target.sources;
        sub.tgt = target; sub.nT = sub.pT = undefined;
        sub.ts = source.lastChanged; sub.old = source.adding;
    } else sub = {
        src: source, nS: undefined, pS: target.sources,
        tgt: target, nT: undefined, pT: undefined,
        ts: source.lastChanged, old: source.adding
    }
    // Add subscription to tail of target's sources
    if (target.sources) target.sources.nS = sub;
    target.sources = sub;
    // track that this source has had a subscription added during this calculation
    source.adding = sub;
    // Set up reciprocal subscription if needed
    (target.latestSource === Infinity) || source.subscribe(sub);  // XXX
}

function delsub(sub: Subscription) {
    sub.src.unsubscribe(sub);
    if (sub.nS) sub.nS.pS = sub.pS;
    if (sub.pS) sub.pS.nS = sub.nS;
    sub.src = sub.tgt = sub.nS = sub.pS = sub.nT = sub.pT = undefined;
    sub.old = freesubs;
    freesubs = sub;
}

export class Cell {
    value: any // the value, or, for an effect, the scheduler
    validThrough = 0; // timestamp of most recent validation or recalculation
    lastChanged = 0;  // timestamp of last value change
    latestSource = timestamp; // max lastChanged of this cell or any ancestor source
    flags = 0;
    ctx: Context;
    /** The subscription being added during the current calculation - used for uniqueness */
    adding: Subscription;
    /** Linked list of sources */
    sources: Subscription;
    /** Linked list of targets */
    subscribers: Subscription;

    compute: () => any

    getValue() {
        this.catchUp();
        const dep = current.cell;
        if (dep) {
            if (this.flags & Is.Running) throw new CircularDependency("Cached function dependency cycle");
            // See if we've already got a subscription node for the dependent
            let s = this.adding;
            if (!s || s.tgt !== dep) {
                // nope, it's new
                mksub(this, dep);
            } else {
                // Yep, see if it's a hangover from last time
                if (s.ts === -1) {
                    // yep, mark it reused
                    s.ts = this.lastChanged;
                    if (s.nS) { // if not at end, move it
                        s.nS.pS = s.pS;
                        if (s.pS) s.pS.nS = s.nS;
                        s.nS = undefined;
                        s.pS = dep.sources;
                        dep.sources.nS = s;
                        dep.sources = s;
                    }
                }
                // else it's already done, no need to do anything.
            }
        }
        if (this.flags & Is.Error) throw this.value;
        return this.value;
    }

    setValue(val: any) {
        const cell = current.cell || currentEffect;
        if (cell) {
            if (cell.flags & Is.Lazy) throw new WriteConflict("Side-effects not allowed in cached functions");
            if (this.adding && this.adding.tgt === cell) throw new CircularDependency("Can't update direct dependency");
        } else {
            if (val === this.value) return;
            ++timestamp;
        }
        if (this.validThrough === timestamp) throw new WriteConflict("Value already used");
        markDependentsDirty(this);
        this.value = val;
    }

    catchUp() {
        const {validThrough} = this;
        if (validThrough >= timestamp) return;
        this.validThrough = timestamp;
        if (this.latestSource <= validThrough || !(this.flags & Is.Computed)) return;
        if (this.sources) {
            for(let sub=this.sources; sub; sub = sub.nS) {
                const s = sub.src;
                // if source is clean, skip it (most should be)
                if (s.latestSource <= validThrough) continue;
                // changed since our last compute? we're definitely dirty
                if (sub.ts !== s.lastChanged) return this.doRecalc();
                // not a simple yes or no -- "it's complicated" -- so recurse
                s.catchUp();
                if (s.lastChanged > validThrough) {
                    return this.doRecalc();
                }
            }
        } else return this.doRecalc();
    }

    doRecalc() {
        const oldCtx = swapCtx(this.ctx);
        for(let sub = this.sources; sub; sub = sub.nS) {
            sub.ts = -1; // mark stale for possible reuse
            // attach sub to its source, so we can look it up
            sub.old = sub.src.adding;
            sub.src.adding = sub;
            this.sources = sub;
        }
        this.flags |= Is.Running;
        try {
            if (this.flags & Is.Lazy) {
                this.flags &= ~Is.Error
                try {
                    const future = this.compute();
                    if (future !== this.value || !this.lastChanged) {
                        this.value = future;
                        this.lastChanged = timestamp;
                    }
                } catch(e) {
                    this.flags |= Is.Error
                    this.value = e;
                    this.lastChanged = timestamp;
                }
            } else {
                const b = this.ctx.flow;
                b.cleanup();
                try {
                    b.onCleanup(this.compute());
                    this.lastChanged = timestamp;
                } catch (e) {
                    b.cleanup();
                    this.disposeEffect();
                    if (this.ctx.job) {
                        // tell the owning job about the error
                        this.ctx.job.throw(e);
                    } else {
                        throw e;
                    }
                }
            }
        } finally {
            this.flags &= ~Is.Running;
            swapCtx(oldCtx);
            // reset this.src to the head of the list, dropping stale subscriptions
            let head: Subscription;
            for(let sub = this.sources; sub; ) {
                const pS = sub.pS;
                sub.src.adding = sub.old;
                sub.old = undefined;
                if (sub.ts === -1) delsub(sub); else head = sub;
                sub = pS;
            }
            this.sources = head;
            if (this.flags & Is.Dead) this.disposeEffect();
        }
    }

    disposeEffect() {
        this.flags |= Is.Dead;
        (this.value as EffectScheduler).delete(this);
        if (current !== this.ctx) {
            for(let s=this.sources; s;) { let nS = s.nS; delsub(s); s = nS; }
            this.sources = undefined;
            if (this.ctx.flow) {
                this.ctx.flow.destroy();
                this.ctx.flow = null;
            }
        }
    }

    subscribe(sub: Subscription) {
        if (this.flags & Is.Lazy && !this.subscribers) {
            this.latestSource = timestamp;
            for(let s=this.sources; s; s = s.nS) s.src.subscribe(s);
        }
        if (this.subscribers !== sub && !sub.pT) { // avoid adding already-added subs
            sub.nT = this.subscribers;
            if (this.subscribers) this.subscribers.pT = sub;
            this.subscribers = sub;
        }
    }

    unsubscribe(sub: Subscription) {
        if (sub.nT) sub.nT.pT = sub.pT;
        if (sub.pT) sub.pT.nT = sub.nT;
        if (this.subscribers === sub) this.subscribers = sub.nT;
        if (!this.subscribers && this.flags & Is.Lazy) {
            this.latestSource = Infinity;
            for(let s=this.sources; s; s = s.nS) s.src.unsubscribe(s);
        }
    }

    static mkValue<T>(val: T) {
        const cell = new Cell;
        cell.value = val;
        cell.lastChanged = timestamp;
        return cell;
    }

    static mkCached<T>(compute: () => T) {
        const cell = new Cell;
        cell.compute = compute;
        cell.ctx = makeCtx(null, null, cell);
        cell.flags = Is.Lazy;
        cell.latestSource = Infinity;
        return cell.getValue.bind(cell);
    }

    static mkEffect(fn: (stop: () => void) => OptionalCleanup, parent: ActiveFlow, scheduler = defaultQueue) {
        if (parent) unlink = parent.addLink(stop);
        var cell = new Cell;
        cell.value = scheduler;
        cell.compute = fn.bind(null, stop);
        cell.ctx = makeCtx(current.job, flow(), cell);
        cell.flags = Is.Effect;
        scheduler.add(cell);
        var unlink: () => void;
        return stop;
        function stop() {
            if (unlink) unlink();
            if (cell) {
                cell.disposeEffect();
                cell = undefined;
            }
        }
    }
}
