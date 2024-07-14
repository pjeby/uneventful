import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { type RuleQueue, currentRule, ruleQueue, defaultQ, ruleStops } from "./scheduling.ts";
import { Job, OptionalCleanup, RecalcSource } from "./types.ts"
import { detached, getJob, makeJob } from "./tracking.ts";
import { Connection, Inlet, IsStream, Sink, Source, backpressure } from "./streams.ts";
import { apply, setMap } from "./utils.ts";
import { isError, markHandled } from "./results.ts";
import { nullCtx } from "./internals.ts";
import { defer } from "./defer.ts";

/**
 * Error indicating a rule has attempted to write a value it indirectly
 * depends on, or which has already been read by another rule in the current
 * batch. (Also thrown when a cached function attempts to write a value at all,
 * directly or indirectly.)
 *
 * @category Errors
 */
export class WriteConflict extends Error {}

/**
 * Error indicating a rule has attempted to write a value it directly depends
 * on, or a cached function has called itself, directly or indirectly.
 *
 * @category Errors
 */
export class CircularDependency extends Error {}

var timestamp = 1;

/** recalcWhen(fn): map fn -> signal */
const fntrackers = new WeakMap<Function, () => number>();

/** recalcWhen(key, factory): map factory -> key -> signal */
const obtrackers = new WeakMap<Function, WeakMap<WeakKey, () => number>>();

/** stream controllers for stream+recalcWhen signals */
const streamtrackers = new WeakMap<Cell, ()=>void>();

const dirtyStack: Cell[] = [];

function markDependentsDirty(cell: Cell) {
    // We don't set validThrough here because that's how we tell the cell's been read/depended on
    const latestSource = cell.latestSource = timestamp;
    for(; cell; cell = dirtyStack.pop()) {
        for (let sub=cell.subscribers; sub; sub = sub.nT) {
            const tgt = sub.tgt;
            if (tgt.latestSource >= latestSource) continue;
            tgt.latestSource = latestSource;
            tgt.queue?.add(tgt);
            if (tgt.subscribers) dirtyStack.push(tgt);
        }
    }
}

// The .compute for a cell whose value has been explicitly set
function returnValue(this: Cell) {
    return this.value;
}

// The compute for a cell whose value is an explicit error
function throwValue(this: Cell) {
    throw this.value;
}

/**
 * Cells that are known to be clean as of this timestamp, but have not been
 * marked as read yet (and whose sources might also not be marked read).  This
 * lets us lazily determine if a cell's value has been depended on (i.e.
 * "virtually read") in this timestamp, even if it wasn't *actually* read.
 */
const notCaughtUp = [] as Cell[];

const enum Is {
    Compute  = 1 << 2,
    Error    = 1 << 4,
    Running  = 1 << 5,
    Stream   = 1 << 6,
    Mutable  = 1 << 7,
    Demanded = 1 << 8,            // Stream has been queued for demand update
    Demand   = Stream | Demanded, // Mask for checking if stream + unqueued
    Variable = Compute | Mutable,
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
    if (target.subscribers || target.queue) source.subscribe(sub);
}

function delsub(sub: Subscription) {
    sub.src.unsubscribe(sub);
    if (sub.nS) sub.nS.pS = sub.pS;
    if (sub.pS) sub.pS.nS = sub.nS;
    sub.src = sub.tgt = sub.nS = sub.pS = sub.nT = sub.pT = undefined;
    sub.old = freesubs;
    freesubs = sub;
}

function subscribeAll(s: Subscription) {
    if (s) while (s.pS) s = s.pS; else return;
    for(; s; s = s.nS) s.src.subscribe(s);
}

function unsubscribeAll(s: Subscription) {
    if (s) while (s.pS) s = s.pS; else return;
    for(; s; s = s.nS) s.src.unsubscribe(s);
}

const sentinel = {}  // a unique value for uniqueness checking

export class Cell {
    value: any = undefined // the value
    validThrough = 0; // timestamp of most recent validation or recalculation
    lastChanged = 0;  // timestamp of last value change
    latestSource = timestamp; // max lastChanged of this cell or any ancestor source
    flags = 0;
    ctx: Context = undefined;
    /** The subscription being added during the current calculation - used for uniqueness */
    adding: Subscription = undefined;
    /** Linked list of sources */
    sources: Subscription = undefined;
    /** Linked list of targets */
    subscribers: Subscription = undefined;
    queue: RuleQueue = undefined;

    /**
     * The computation to be performed (if {@link Is.Compute}) or the
     * setup/teardown for {@link Is.Stream}.
     */
    compute: (sub?: boolean) => any = returnValue;

    stream<T>(sink: Sink<T>, _conn?: Connection, inlet?: Inlet) {
        let lastValue = sentinel;
        Cell.mkRule(() => {
            const val = this.getValue();
            if (val !== lastValue) {
                const old = swapCtx(nullCtx);
                try { sink(lastValue = val); } finally { swapCtx(old); }
            }
        }, inlet ? ruleQueue(backpressure(inlet)) : defaultQ);
        return IsStream;
    }

    getValue() {
        if (arguments.length) return apply(this.stream, this, arguments);
        this.catchUp();
        const dep = current.cell;
        // Only create a dependency if our value can change
        if (dep && this.flags & Is.Variable) {
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

    shouldWrite(changed: boolean) {
        const cell = current.cell || currentRule;
        if (cell) {
            // When a cell changes within a sweep (i.e. from an active rule or other
            // cell), we need to check if it's not a circular update or disallowed
            // side-effect.  In such a case we bail out with an error, even if the
            // change is idempotent.  (To avoid hiding value-dependent errors.)
            if (!cell.queue) throw new WriteConflict("Side-effects not allowed outside rules");
            if (this.adding && this.adding.tgt === cell) throw new CircularDependency("Can't update direct dependency");
            if (this.validThrough === timestamp || this.hasBeenRead()) throw new WriteConflict("Value already used");
        } else if (changed) {
            // We are *not* in a sweep, but *did* have a change.  So we may need to advance
            // the timestamp, if we might have had readers in the current one.
            if (this.validThrough === timestamp || notCaughtUp.length) { ++timestamp; notCaughtUp.length = 0; }
        } else {
            // Not in a sweep and no change -- no need to actually write anything
            return false;
        }
        // If we changed as of the current timestamp, we're already dirty
        // Otherwise, we should flag our subscribers as such.
        (this.lastChanged === timestamp) || markDependentsDirty(this);
        // If we have sources, reset the subscription timestamp of the first one
        // to force a recalculation on our next catchUp().
        if (this.sources) this.sources.ts = 0;
        return true;
    }

    setValue(val: any, isErr: boolean) {
        if (this.shouldWrite(val !== this.value || isErr !== !!(this.flags & Is.Error))) {
            this.value = val;
            this.lastChanged = timestamp;
            this.flags = isErr ? this.flags | Is.Error : this.flags & ~Is.Error;
        }
        // We always reset the compute here because we might have been in the
        // Calc state.  But we don't clear the Calc flag because we might need
        // any previous sources to be released or unsubscribed.  (Which will
        // happen on our next recalc.)
        this.compute = isErr ? throwValue : returnValue;
    }

    setCalc(compute: () => any) {
        if (this.shouldWrite(compute !== this.compute)) {
            this.flags |= Is.Compute;
            this.compute = compute;
            this.ctx ||= makeCtx(null, this);
        }
    }

    hasBeenRead() {
        if (notCaughtUp.length) {
            for(const cell of notCaughtUp) cell.catchUp();
            notCaughtUp.length = 0;
        }
        return this.validThrough === timestamp;
    }

    catchUp(): void {
        const {validThrough} = this;
        if (validThrough === timestamp) return;
        this.validThrough = timestamp;
        if (!(this.flags & Is.Compute)) return;
        if (this.sources) {
            for(let sub=this.sources; sub; sub = sub.nS) {
                const s = sub.src;
                // changed since our last compute? we're definitely dirty
                if (sub.ts !== s.lastChanged) return this.doRecalc();
                // if source is clean, skip it (most should be)
                // (note: only cells w/subscribers can be trusted as to their
                // latestSource, as cacheds with no subscribers don't get
                // notified by their upstreams)
                if (s.subscribers && s.latestSource <= validThrough) continue;
                // not a simple yes or no -- "it's complicated" -- so recurse
                s.catchUp();
                if (s.lastChanged > validThrough) {
                    return this.doRecalc();
                }
            }
            // If we got to this point, we didn't need to recalc, but that means
            // none of our sources actually *changed*, despite at least one being
            // dirty.  But that means we "virtually" read the clean values and
            // therefore depended on them... which means if they get written to,
            // either the timestamp must change or the write must be blocked.
            //
            // So we put them on our notCaughtUp list, in order to prevent rules
            // from changing them (or their sources) in the same timestamp, and
            // so that non-rule writes will know to update the timestamp.
            for(let sub=this.sources; sub; sub = sub.nS) {
                if (sub.src.validThrough !== timestamp) notCaughtUp.push(sub.src);
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
            try {
                const future = this.compute();
                if (future !== this.value || !this.lastChanged || this.flags & Is.Error) {
                    this.value = future;
                    this.lastChanged = timestamp;
                }
                this.flags &= ~Is.Error;
            } catch(e) {
                this.flags |= Is.Error
                this.value = e;
                this.lastChanged = timestamp;
                if (currentRule === this) throw e;
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
            if (!head) {
                // without sources, we can never change or be invalidated, so
                // revert to settable value() or permanent constant
                this.flags &= ~Is.Compute;
            }
        }
    }

    stop() {
        this.setQ(null);
        ruleStops.get(this)?.();
    }

    setQ(queue = defaultQ) {
        // Don't unsubscribe if we have subscribers or there's going to be a queue
        queue || this.subscribers || unsubscribeAll(this.sources);
        if (this.queue) {
            // Only add to new queue if queued on old
            if (this.queue.has(this)) queue?.add(this);
            this.queue.delete(this);
            queue || this.ctx.job?.restart();
        } else if (queue) {
            // initial queue or re-enable, schedule it
            queue.add(this);
            // If we already have subscribers, we're already subscribed
            this.subscribers || subscribeAll(this.sources);
        }
        this.queue = queue;
    }

    subscribe(sub: Subscription) {
        if (!this.subscribers) {
            this.queue || subscribeAll(this.sources);
            // subscribe to source
            if ((this.flags & Is.Demand) === Is.Stream) this.updateDemand();
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
        sub.nT = sub.pT = undefined;
        if (!this.subscribers) {
            this.queue || unsubscribeAll(this.sources);
            // unsubscribe from source
            if ((this.flags & Is.Demand) === Is.Stream) this.updateDemand();
        }
    }

    static mkValue<T>(val: T) {
        const cell = new Cell;
        cell.flags = Is.Mutable;
        cell.value = val;
        cell.lastChanged = timestamp;
        return cell;
    }

    updateDemand() {
        this.flags |= Is.Demanded;
        defer(streamtrackers.get(this));
    }

    static mkStream<T>(src: Source<T>, val?: T) {
        const cell = this.mkValue(val);
        cell.flags |= Is.Stream;
        const ctx = makeCtx();
        const write = (v: T) => { cell.setValue(v, false);  };
        let job: Job<void>;
        streamtrackers.set(cell, () => {
            if (!(cell.flags & Is.Demanded)) return;
            cell.flags &= ~(Is.Demanded);
            if (!cell.subscribers) {
                // Last subscriber is gone, so reset to default value
                write(val);
                job?.end();  // unsubscribe from source
                return
            }
            if (job) return;
            job = ctx.job = makeJob<void>().do(r => {
                if (isError(r)) {
                    cell.setValue(markHandled(r), true);
                } else {
                    cell.setValue(val, false);
                }
                ctx.job = job = undefined;
            });
            const old = swapCtx(ctx);
            try {
                src(write, job);
            } catch(e) {
                job.end();
                detached.asyncThrow(e);
            } finally {
                swapCtx(old);
            }
        });
        return cell;
    }

    recalcWhen(src: RecalcSource): void;
    recalcWhen<T extends WeakKey>(key: T, factory: (key: T) => RecalcSource): void;
    recalcWhen<T extends WeakKey>(fnOrKey: T | RecalcSource, fn?: (key: T) => RecalcSource) {
        let trackers: WeakMap<WeakKey, () => number> = fn ?
            obtrackers.get(fn) || setMap(obtrackers, fn, new WeakMap) :
            fntrackers
        ;
        let signal = trackers.get(fnOrKey);
        if (!signal) {
            const src = fn ? fn(<T>fnOrKey) : <RecalcSource> fnOrKey;
            let ct = 0;
            const c = Cell.mkStream(s => (src(() => s(++ct)), IsStream), ct);
            trackers.set(fnOrKey, signal = c.getValue.bind(c));
        }
        signal();  // Subscribe to the cell
    }

    static mkCached<T>(compute: () => T) {
        const cell = new Cell;
        cell.compute = compute;
        cell.ctx = makeCtx(null, cell);
        cell.flags = Is.Compute;
        return cell;
    }

    static mkRule(fn: (stop: () => void) => OptionalCleanup, q: RuleQueue) {
        const cell = new Cell, outer = getJob(), job = makeJob(), stop = cell.stop.bind(cell);
        outer === detached || ruleStops.set(cell, outer.release(stop));
        cell.compute = () => {
            try {
                job.restart().must(fn(stop));
                cell.lastChanged = timestamp;
            } catch (e) {
                stop();
                throw e;
            }
        }
        cell.ctx = makeCtx(job, cell);
        cell.flags = Is.Compute;
        cell.setQ(q);
        return stop;
    }
}
