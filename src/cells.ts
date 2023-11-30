import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { defer } from "./defer.ts";
import { ActiveBin, OptionalCleanup, bin } from "./bins.ts";

export class WriteConflict extends Error {}
export class CircularDependency extends Error {}

export function mkCached<T>(compute: (old: T) => T, initial?: T) {
    const cell = new Cell<T>;
    cell.value = initial;
    cell.compute = compute;
    cell.latestSource = timestamp;  // force revalidation on first use
    cell.ctx = makeCtx(null, null, cell);
    cell.flags = Is.Lazy;
    cell.latestSource = Infinity;
    return cell.getValue.bind(cell);
}

export function mkEffect(fn: (stop: () => void) => OptionalCleanup, parent: ActiveBin) {
    if (parent) unlink = parent.addLink(stop);
    var cell = new Cell;
    cell.compute = fn.bind(null, stop);
    cell.ctx = makeCtx(current.job, bin(), cell);
    cell.flags = Is.Effect;
    effectQueue.add(cell);
    var unlink: () => void;
    runningEffects || scheduleEffects();
    return stop;
    function stop() {
        if (unlink) unlink();
        if (cell) {
            cell.disposeEffect();
            cell = undefined;
        }
    }
}

const effectQueue = new Set<Cell>;
var timestamp = 1;
var runningEffects = false;

/**
 * Synchronously run pending effects (no-op if already running)
 *
 * (Note that you should normally only need to call this when you need
 * side-effects to occur within a specific synchronous timeframe, e.g. if
 * effects need to be able to cancel a synchronous event, continue an IndexedDB
 * transaction, or run in an animation frame.)
 *
 * @category Signals
 */
export function runEffects() {
    if (runningEffects) return;
    runningEffects = true;
    try {
        // run effects marked dirty by value changes
        for(const e of effectQueue) e.catchUp();
        effectQueue.clear();
    } finally {
        runningEffects = false;
        if (effectQueue.size) scheduleEffects();
    }
}

var runScheduled = false;

function scheduleEffects() {
    if (!runningEffects && !runScheduled) {
        defer(scheduledRun);
        runScheduled = true;
    }
}

function scheduledRun() {
    runScheduled = false;
    runEffects();
}

const dirtyStack: Cell[] = [];

function markDependentsDirty(cell: Cell) {
    const latestSource = cell.lastChanged = cell.latestSource = timestamp;
    var err = false;
    for(; cell; cell = dirtyStack.pop()) {
        for (let sub=cell.subscribers; sub; sub = sub.nT) {
            const tgt = sub.tgt;
            if (tgt.latestSource >= latestSource) {
                // We encountered an already dirty subtree; check if it's been
                // recalculated already.  If so, the update should fail since
                // it would be a "lost" update (i.e., the subtree saw the value
                // before it was changed.)
                err ||= (tgt.validThrough === timestamp);
                continue;
            }
            tgt.latestSource = latestSource;
            if (tgt.flags & Is.Effect) { effectQueue.add(tgt); runningEffects || scheduleEffects(); }
            if (tgt.subscribers) dirtyStack.push(tgt);
        }
    }
    if (err) throw new WriteConflict("Read/write conflict");
}


const enum Is {
    Effect = 1 << 0,
    Lazy   = 1 << 2,
    Dead   = 1 << 3,
    Running = 1 << 5,
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

export class Cell<T=any> {
    value: T
    validThrough = 0; // timestamp of most recent validation or recalculation
    lastChanged = 0;  // timestamp of last value change
    latestSource = 0; // max lastChanged of this cell or any ancestor source
    flags = 0;
    ctx: Context;
    /** The subscription being added during the current calculation - used for uniqueness */
    adding: Subscription;
    /** Linked list of sources */
    sources: Subscription;
    /** Linked list of targets */
    subscribers: Subscription;

    compute: (val?: T) => any

    getValue() {
        if (timestamp > this.validThrough && this.latestSource > this.validThrough) this.catchUp();
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
        return this.value;
    }

    setValue(val: T) {
        const cell = current.cell;
        if (cell) {
            if (cell.flags & Is.Lazy) throw new WriteConflict("Side-effects not allowed in cached functions");
            if (this.adding && this.adding.tgt === cell) throw new CircularDependency("Can't update your dependency");
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
        if (this.sources) {
            for(let sub=this.sources; sub; sub = sub.nS) {
                const s = sub.src;
                if (timestamp > s.validThrough && s.latestSource > s.validThrough) s.catchUp();
                if (s.lastChanged > validThrough) {
                    return this.doRecalc();
                }
            }
            this.validThrough = timestamp;
        } else {
            return this.doRecalc();
        }
    }

    doRecalc() {
        this.validThrough = timestamp;
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
                const future = this.compute(this.value);
                if (future !== this.value || !this.lastChanged) {
                    this.value = future;
                    this.lastChanged = timestamp;
                }
            } else {
                const b = this.ctx.bin;
                b.cleanup();
                try {
                    b.add(this.compute());
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
        effectQueue.delete(this);
        if (current !== this.ctx) {
            for(let s=this.sources; s;) { let nS = s.nS; delsub(s); s = nS; }
            this.sources = undefined;
            if (this.ctx.bin) {
                this.ctx.bin.destroy();
                this.ctx.bin = null;
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
}
