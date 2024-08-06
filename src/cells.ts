import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { DisposeFn, Job, OptionalCleanup, RecalcSource } from "./types.ts"
import { detached, getJob, makeJob } from "./tracking.ts";
import { Connection, Inlet, IsStream, Sink, Source, backpressure } from "./streams.ts";
import { apply, arrayEq, setMap } from "./utils.ts";
import { isError, markHandled } from "./results.ts";
import { nullCtx } from "./internals.ts";
import { defer } from "./defer.ts";
import { Batch, batch } from "./scheduling.ts";
import { action, peek, type Configurable } from "./signals.ts";

const ruleQueues = new WeakMap<Function, RuleQueue>();
export function ruleQueue(scheduleFn: (cb: () => unknown) => unknown = defer) {
    ruleQueues.has(scheduleFn) || ruleQueues.set(scheduleFn, batch<Cell>(runRules, scheduleFn));
    return ruleQueues.get(scheduleFn);
}

export type RuleQueue = Batch<Cell>;
export var currentRule: Cell;
export const ruleStops = new WeakMap<Cell, DisposeFn>();
export const defaultQ = /* @__PURE__ */ ruleQueue(defer);

var currentQueue: RuleQueue;
function runRules(this: RuleQueue, q: Set<Cell>) {
    // another queue is running? reschedule for later
    if (currentQueue) return;
    currentQueue = this;
    try {
        // run rules marked dirty by value changes
        for (currentRule of q) {
            currentRule.catchUp();
            q.delete(currentRule);
        }
    } finally {
        currentQueue = currentRule = undefined;
    }
}

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
const monitors = new WeakMap<Cell, ()=>void>();

/** Cells whose demand has changed and need to start/stop jobs, etc. */
export const demandChanges = batch<Cell>(q => { for(const cell of q) cell.updateDemand(); });

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
    Observed = 1 << 0,  // Cell has subscribers or a rule queue
    Stopped  = 1 << 1,  // Stateful cell requested stop
    Compute  = 1 << 2,
    Error    = 1 << 4,
    Running  = 1 << 5,
    Stateful = 1 << 6,  // Cell has state (e.g. job, stream) that depends on its observed-ness
    Mutable  = 1 << 7,
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
    if (target.flags & Is.Observed) source.subscribe(sub);
}

/** Delete subscription, with recursive constant folding */
function removeConstListener(sub: Subscription) {
    const{tgt, nS, pS} = sub;
    if (sub.src.adding === sub) sub.src.adding = sub.old;
    delsub(sub);
    // Recurse if its source list becomes empty
    if (tgt.sources === sub) (tgt.sources = nS || pS) || tgt.becomeConstant();
}

/** Delete subscription as part of recalc cleanup only */
function delsub(sub: Subscription) {
    sub.src.unsubscribe(sub);
    if (sub.nS) sub.nS.pS = sub.pS;
    if (sub.pS) sub.pS.nS = sub.nS;
    sub.src = sub.tgt = sub.nS = sub.pS = sub.nT = sub.pT = undefined;
    sub.old = freesubs;
    freesubs = sub;
}

function subscribeAll(c: Cell) {
    for(let s = firstSource(c); s; s = s.nS) s.src.subscribe(s);
    toggleDemand(c);
}

function unsubscribeAll(c: Cell) {
    for(let s = firstSource(c); s; s = s.nS) s.src.unsubscribe(s);
    toggleDemand(c);
}

const sentinel = {}  // a unique value for uniqueness checking

function firstSource(c: Cell) {
    let s = c.sources;
    if (s) while (s.pS) s = s.pS;  // Back up to the start (in case the cell is running)
    return s;
}

function toggleDemand(c: Cell) {
    // We toggle the observed flag to match our current state; if we're also
    // stateful, we need to toggle our "dirty" status in the demand queue, too.
    if (((c.flags ^= Is.Observed) & Is.Stateful) === Is.Stateful) {
        // If we were already in the queue, then we were dirty in the old state,
        // which means we're *clean* in the new state, and vice versa.  This
        // lets us avoid redundant work in the queue when demand briefly
        // flip-flops (due to e.g. nested rules being restarted).
        demandChanges.has(c) ? demandChanges.delete(c) : demandChanges.add(c);
    }
}

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
     * setup/teardown for {@link Is.Stateful}.
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
        const dep = current.cell;
        // Only create a dependency if our value can change
        if (dep && this.flags & Is.Variable) {
            if (this.flags & Is.Running) throw new CircularDependency("Cached function dependency cycle");
            // See if we've already got a subscription node for the dependent
            let s = this.adding;
            if (!s || s.tgt !== dep) {
                // nope, it's new
                mksub(this, dep);
                s = this.adding;
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
            this.catchUp();
            if (this.adding === s) s.ts = this.lastChanged;
        } else this.catchUp();
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
        // to force a recalculation on our next catchUp().  (It should be safe
        // because if we were running, we'd have thrown "value already used" above.)
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
        const {ctx} = this, oldCtx = swapCtx(ctx);
        if (this.flags & Is.Stateful) {
            ctx.job?.restart();
        }
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
            if (this.flags & Is.Stateful) {
                demandChanges.delete(this);
                if (this.flags & (Is.Error|Is.Stopped)) {
                    this.flags &= ~Is.Stopped;
                    ctx.job?.restart();
                } else if (this.flags & Is.Observed) {
                } else {
                    ctx.job?.restart();
                }
            }
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
            // without sources, we can never change or be invalidated, so flag as uncomputable
            (this.sources = head) || this.becomeConstant()
        }
    }

    becomeConstant() {
        // Not safe if running, and running cells will do this on exit anyway.
        // And if we're stateful, we can change by being observed/unobserved, so
        // aren't really constant.
        if (this.flags & (Is.Running | Is.Stateful)) return;

        this.flags &= ~Is.Compute;

        // If we're mutable, don't delete subscriptions
        if (this.flags & Is.Variable) return;

        // It's safe to delete subscriptions in the adding stack, because those
        // cells are already reading the current value (or not) during their
        // active recalc.
        while (this.adding) removeConstListener(this.adding);

        // For any other subscriptions, we only delete ones that match our timestamp,
        // as they've already read our latest value.  The rest will have to wait
        // until they recalc, at which point they won't renew their subscription and
        // it'll get cleared out then.  (And propagate if applicable.)
        for(let sub = this.subscribers; sub; ) {
            const {nT} = sub; (sub.ts !== this.lastChanged) || removeConstListener(sub); sub = nT;
        }
    }

    stop() {
        this.setQ(null);
        // force immediate stop unless we're running (in which case doRecalc
        // will handle it for us, since we have no demand any more):
        if (this.flags & Is.Running) { this.flags |= Is.Stopped; } else this.updateDemand();
        ruleStops.get(this)?.();
    }

    setQ(queue: RuleQueue|null = defaultQ) {
        if (queue == this.queue) return;  // use `==` to ignore null/undefined
        if (!this.subscribers) {
            // Without subscribers, adding/removing a queue will change demand,
            // so we'll need to unsubscribe from sources if (and ONLY if) we're
            // removing a *currently active* queue:
            queue || !this.queue || unsubscribeAll(this);
        }
        if (this.queue) {
            // Only add to new queue if queued on old
            if (this.queue.has(this)) queue?.add(this);
            this.queue.delete(this);
        } else if (queue) {
            // initial queue or re-enable, schedule it
            queue.add(this);
            // If we already have subscribers, we're already subscribed
            this.subscribers || subscribeAll(this);
        }
        this.queue = queue;
    }

    subscribe(sub: Subscription) {
        if (!this.subscribers && !this.queue) {
            // 0->1 subs, engage demand (unless we already have it via queue)
            subscribeAll(this);
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
        if (!this.subscribers && !this.queue) {
            // 1->0 subs, remove demand (unless we still have it via queue)
            unsubscribeAll(this);
        }
    }

    static mkValue<T>(val: T) {
        const cell = new Cell;
        cell.flags = Is.Mutable;
        cell.value = val;
        cell.lastChanged = timestamp;
        return cell;
    }

    isObserved() {
        // intentional side effect: start state tracking
        return !!((this.flags|= Is.Stateful) & Is.Observed);
    }

    getJob() {
        this.flags |= Is.Stateful;
        return this.ctx.job ||= makeJob();
    }

    updateDemand() {
        demandChanges.delete(this);
        if (monitors.has(this)) {
            monitors.get(this)();
        } else if (this.flags & Is.Observed) {
            // Trigger an async update so we run on the right scheduler
            this.shouldWrite(true);
        } else {
            // no demand: restart job if active
            this.ctx.job?.restart();
        }
    }

    static mkStream<T>(src: Source<T>, val?: T) {
        const cell = this.mkValue(val);
        cell.flags |= Is.Stateful;
        const ctx = makeCtx();
        const write = (v: T) => { cell.setValue(v, false);  };
        let job: Job<void>;
        monitors.set(cell, () => {
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

    static mkRule(fn: () => OptionalCleanup, q: RuleQueue) {
        const outer = getJob(), cell = Cell.mkCached(() => {
            try {
                const cleanup = fn();
                if (cleanup) (cell.ctx.job || cell.getJob()).must(cleanup);
                cell.lastChanged = timestamp;
            } catch (e) {
                cell.stop();
                throw e;
            }
        }), stop = cell.stop.bind(cell);
        outer === detached || ruleStops.set(cell, outer.release(stop));
        cell.setQ(q);
        return stop;
    }
}

/**
 * Keep an expression's old value unless there's a semantic change
 *
 * By default, reactive values (i.e. {@link cached}(), or {@link value}() with a
 * {@link Configurable.setf setf}()) are considered to have "changed" (and thus
 * trigger recalculation of their dependents) when they are different according
 * to `===` comparison.
 *
 * This works well for primitive values, but for arrays and objects it's not
 * always ideal, because two arrays can have the exact same elements and still
 * be different according to `===`.  So this function lets you substitute a
 * different comparison function (like a deep-equal or shallow-equal) instead.
 * (The default is {@link arrayEq}() if no compare function is supplied.)
 *
 * Specifically, if your reactive expression returns `unchangedIf(newVal,
 * compare)`, then the expression's previous value will be kept if the compare
 * function returns true when called with the old and new values. Otherwise, the
 * new value will be used.
 *
 * @remarks
 * - If the reactive expression's last "value" was an error, the new value is
 *   returned
 * - An error will be thrown if this function is called outside a reactive
 *   expression or from within a {@link peek}() call or {@link action} wrapper.
 *
 * @category Reactive Values
 */

export function unchangedIf<T>(newVal: T, equals: (v1: T, v2: T) => boolean = arrayEq): T {
    const {cell} = current;
    if (cell) {
        return (cell.flags & Is.Error || !equals(cell.value, newVal)) ? newVal : cell.value;
    } else {
        throw new Error("unchangedIf() must be called from a reactive expression");
    }
}
