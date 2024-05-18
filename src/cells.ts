import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { defer } from "./defer.ts";
import { RunQueue } from "./scheduling.ts";
import { DisposeFn, OptionalCleanup, RecalcSource } from "./types.ts"
import { detached, getJob, makeJob } from "./tracking.ts";
import { Connection, Inlet, IsStream, Sink, Producer, backpressure } from "./streams.ts";
import { setMap } from "./utils.ts";
import { isCancel } from "./results.ts";
import { nullCtx } from "./internals.ts";

/**
 * Error indicating a rule has attempted to write a value it indirectly
 * depends on, or which has already been read by another rule in the current
 * batch. (Also thrown when a cached function attempts to write a value at all,
 * directly or inidirectly.)
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
var currentRule: Cell;
var currentQueue: RuleScheduler;

/**
 * A queue for rules to run during a particular kind of period, such as
 * microtasks or animation frames.  (Can only be obtained or created via
 * {@link RuleScheduler.for}().)
 *
 * @category Signals
 */
export class RuleScheduler {

    /** @internal */
    protected static cache = new WeakMap<Function, RuleScheduler>();

    /** @internal */
    protected readonly q: RunQueue<Cell>;

    /**
     * Run all pending rules on this scheduler.
     *
     * This is a bound method
     *
     * (Note: "pending" rules are ones with at least one changed ancestor
     * dependency; this doesn't mean they will actually *do* anything,
     * since intermediate cached() function results might end up unchanged.)
     */
    flush: () => void;

    /**
     * Create an {@link RuleScheduler} from a callback-taking function, that
     * you can then use to make rules that run in a specific time frame.
     *
     * ```ts
     * // frame.rule will now create rules that run during animation fames
     * const animate = RuleScheduler.for(requestAnimationFrame).rule;
     *
     * animate(() => {
     *     // ... do stuff in an animation frame when signals used here change
     * })
     * ```
     *
     * Returns the default scheduler if no arguments are given.  If called with
     * the same function more than once, it returns the same scheduler instance.
     *
     * @param scheduleFn A single-argument scheduling function (like
     * requestAnimationFrame, setImmediate, or queueMicrotask).  The scheduler
     * will call it from time to time with a single callback.  The scheduling
     * function should then arrange for that callback to be invoked *once* at
     * some future point, when it is the desired time for all pending rules on
     * that scheduler to run.
     */
    static for(scheduleFn: (cb: () => unknown) => unknown = defer) {
        this.cache.has(scheduleFn) || this.cache.set(scheduleFn, new this(scheduleFn));
        return this.cache.get(scheduleFn);
    }

    protected constructor(_scheduleFn: (cb: () => unknown) => unknown = defer) {
        this.q = new RunQueue<Cell>(_scheduleFn, _queue => {
            // another queue is running? reschedule for later
            if (currentQueue) return;
            currentQueue = this;
            try {
                // run rules marked dirty by value changes
                for(currentRule of _queue) {
                    currentRule.catchUp();
                    _queue.delete(currentRule);
                }
            } finally {
                currentQueue = currentRule = undefined;
            }
        });
        this.flush = this.q.flush;
    }

    /**
     * @inheritdoc rule tied to a specific scheduler.  See {@link rule} for
     * more details.
     *
     * @remarks The rule will only run during its matching
     * {@link RuleScheduler.flush}().
     *
     * This is a bound method, so you can use it independently of the scheduler
     * it came from.
     */
    rule = (fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn => {
        return Cell.mkRule(fn, this.q);
    };
}

const defaultQueue = RuleScheduler.for(defer);

/**
 * Subscribe a function to run every time certain values change.
 *
 * @remarks
 * The function is run asynchronously, first after being created, then again
 * after there are changes in any of the values or cached functions it read
 * during its previous run.
 *
 * The created subscription is tied to the currently-active job (which may be
 * another rule).  So when that job is ended or restarted, the rule will be
 * terminated automatically.  You can also terminate it early by calling the
 * "stop" function that is both passed to the rule function and returned by
 * `rule()`.
 *
 * Note: this function will throw an error if called without an active job. If
 * you need a standalone rule, use {@link detached}.run to wrap the
 * call to rule.
 *
 * @param fn The function that will be run each time its dependencies change.
 * The function will be run in a restarted job each time, with any resources
 * used by the previous run being cleaned up.  The function is passed a single
 * argument: a function that can be called to terminate the rule.   The function
 * should return a cleanup function or void.
 *
 * @returns A function that can be called to terminate the rule.
 *
 * @category Signals
 */
export const rule = defaultQueue.rule;

/**
 * Synchronously run pending rules from the default scheduler.
 *
 * @remarks Equivalent to calling
 * {@link RuleScheduler.for}(defer).{@link RuleScheduler.flush flush}().
 *
 * Note that you should normally only need to call this when you need
 * side-effects to occur within a specific synchronous timeframe, e.g. if
 * rules need to be able to cancel a synchronous event or continue an
 * IndexedDB transaction.  (You can also define rules to run in a specific
 * timeframe by creating a {@link RuleScheduler} for them, via
 * {@link RuleScheduler.for}.)
 *
 * @category Signals
 */
export const runRules = defaultQueue.flush


/** recalcWhen(fn): map fn -> signal */
const fntrackers = new WeakMap<Function, () => number>();

/** recalcWhen(key, factory): map factory -> key -> signal */
const obtrackers = new WeakMap<Function, WeakMap<WeakKey, () => number>>();

const dirtyStack: Cell[] = [];

function markDependentsDirty(cell: Cell) {
    // We don't set validThrough here because that's how we tell the cell's been read/depended on
    const latestSource = cell.lastChanged = cell.latestSource = timestamp;
    for(; cell; cell = dirtyStack.pop()) {
        for (let sub=cell.subscribers; sub; sub = sub.nT) {
            const tgt = sub.tgt;
            if (tgt.latestSource >= latestSource || tgt.latestSource === 0) continue;
            tgt.latestSource = latestSource;
            if (tgt.flags & Is.Rule) (tgt.value as RunQueue<Cell>).add(tgt);
            if (tgt.subscribers) dirtyStack.push(tgt);
        }
    }
}

/**
 * Cells that are known to be clean as of this timestamp, but have not been
 * marked as read yet (and whose sources might also not be marked read).  This
 * lets us lazily determine if a cell's value has been depended on (i.e.
 * "virtually read") in this timestamp, even if it wasn't *actually* read.
 */
const notCaughtUp = [] as Cell[];

const enum Is {
    Rule = 1 << 0,
    Lazy   = 1 << 2,
    Dead   = 1 << 3,
    Error  = 1 << 4,
    Running = 1 << 5,
    Stream  = 1 << 6,
    Mutable = 1 << 7,
    Computed = Rule | Lazy,
    Variable = Computed | Mutable,
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
    (target.latestSource === 0) || source.subscribe(sub);  // XXX
}

function delsub(sub: Subscription) {
    sub.src.unsubscribe(sub);
    if (sub.nS) sub.nS.pS = sub.pS;
    if (sub.pS) sub.pS.nS = sub.nS;
    sub.src = sub.tgt = sub.nS = sub.pS = sub.nT = sub.pT = undefined;
    sub.old = freesubs;
    freesubs = sub;
}

const sentinel = {}  // a unique value for uniqueness checking

/** @internal */
export class Cell {
    value: any = undefined // the value, or, for a rule, the scheduler
    validThrough = 0; // timestamp of most recent validation or recalculation
    lastChanged = 0;  // timestamp of last value change
    latestSource = timestamp; // max lastChanged of this cell or any ancestor source (0 = Infinity)
    flags = 0;
    ctx: Context = undefined;
    /** The subscription being added during the current calculation - used for uniqueness */
    adding: Subscription = undefined;
    /** Linked list of sources */
    sources: Subscription = undefined;
    /** Linked list of targets */
    subscribers: Subscription = undefined;

    compute: () => any = undefined;

    stream<T>(sink: Sink<T>, _conn?: Connection, inlet?: Inlet) {
        let lastValue = sentinel;
        (inlet ? RuleScheduler.for(backpressure(inlet)).rule : rule)(() => {
            const val = this.getValue();
            if (val !== lastValue) {
                const old = swapCtx(nullCtx);
                try { sink(lastValue = val); } finally { swapCtx(old); }
            }
        });
        return IsStream;
    }

    getValue() {
        if (arguments.length) return this.stream.apply(this, arguments as any);
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

    setValue(val: any) {
        const cell = current.cell || currentRule;
        if (cell) {
            if (cell.flags & Is.Lazy) throw new WriteConflict("Side-effects not allowed in cached functions");
            if (this.adding && this.adding.tgt === cell) throw new CircularDependency("Can't update direct dependency");
            if (this.validThrough === timestamp || this.hasBeenRead()) throw new WriteConflict("Value already used");
        } else {
            // Skip update if unchanged
            if (val === this.value) return;
            // If we might have had readers this timestamp, bump it so they'll run again
            if (this.validThrough === timestamp || notCaughtUp.length) { ++timestamp; notCaughtUp.length = 0; }
        }
        // If we changed as of the current timestamp, we're already dirty
        (this.lastChanged === timestamp) || markDependentsDirty(this);
        this.value = val;
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
        if (!(this.flags & Is.Computed)) return;
        if (this.sources) {
            for(let sub=this.sources; sub; sub = sub.nS) {
                const s = sub.src;
                // if source is clean, skip it (most should be)
                if (s.latestSource !== 0 && s.latestSource <= validThrough) continue;
                // changed since our last compute? we're definitely dirty
                if (sub.ts !== s.lastChanged) return this.doRecalc();
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
                const {job} = this.ctx;
                job.restart();
                try {
                    job.must(this.compute());
                    this.lastChanged = timestamp;
                } catch (e) {
                    this.disposeRule();
                    throw e;
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
            if (!head) {
                // without sources, we can never change or be invalidated, so
                // revert to settable value() or permanent constant
                this.flags &= ~Is.Lazy;
            }
            if (this.flags & Is.Dead) this.disposeRule();
        }
    }

    disposeRule() {
        this.ctx.job.end();
        this.flags |= Is.Dead;
        (this.value as RunQueue<Cell>).delete(this);
        if (current !== this.ctx) {
            for(let s=this.sources; s;) { let nS = s.nS; delsub(s); s = nS; }
            this.sources = undefined;
        }
    }

    subscribe(sub: Subscription) {
        if (!this.subscribers) {
            if (this.flags & Is.Lazy) {
                this.latestSource = timestamp;
                for(let s=this.sources; s; s = s.nS) s.src.subscribe(s);
            }
            if (this.flags & Is.Stream) this.compute();  // subscribe to source
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
        if (!this.subscribers) {
            if (this.flags & Is.Lazy) {
                this.latestSource = 0;
                for(let s=this.sources; s; s = s.nS) s.src.unsubscribe(s);
            }
            if (this.flags & Is.Stream) this.ctx.job?.restart();  // unsubscribe from source
        }
    }

    static mkValue<T>(val: T) {
        const cell = new Cell;
        cell.flags = Is.Mutable;
        cell.value = val;
        cell.lastChanged = timestamp;
        return cell;
    }

    static mkStream<T>(src: Producer<T>, val?: T): () => T {
        const cell = this.mkValue(val);
        cell.flags |= Is.Stream;
        cell.ctx = makeCtx();
        const write = cell.setValue.bind(cell);
        cell.compute = () => {
            cell.ctx.job ||= makeJob()
                .asyncCatch(e => detached.asyncThrow(e))
                .must(r => { cell.value = val; isCancel(r) || (cell.ctx.job = undefined); })
            ;
            const old = swapCtx(cell.ctx);
            try {
                src(write);
            } catch(e) {
                detached.asyncThrow(e);
                cell.ctx.job.end();
                cell.ctx.job = undefined;
            } finally {
                swapCtx(old);
            }
        }
        return cell.getValue.bind(cell);
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
            signal = Cell.mkStream(s => (src(() => s(++ct)), IsStream), ct);
            trackers.set(fnOrKey, signal);
        }
        signal();  // Subscribe to the cell
    }

    static mkCached<T>(compute: () => T): () => T {
        const cell = new Cell;
        cell.compute = compute;
        cell.ctx = makeCtx(null, cell);
        cell.flags = Is.Lazy;
        cell.latestSource = 0;
        return cell.getValue.bind(cell);
    }

    static mkRule(fn: (stop: () => void) => OptionalCleanup, q: RunQueue<Cell>) {
        var unlink = getJob().release(stop);
        var cell = new Cell, f = makeJob();
        cell.value = q;
        cell.compute = fn.bind(null, stop);
        cell.ctx = makeCtx(f, cell);
        cell.flags = Is.Rule;
        q.add(cell);
        return stop;
        function stop() {
            unlink();
            if (cell) {
                cell.disposeRule();
                cell = undefined;
            }
        }
    }
}
