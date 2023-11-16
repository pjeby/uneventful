import { Context, current, makeCtx, swapCtx } from "./ambient.ts";
import { defer } from "./defer.ts";
import { ActiveBin, OptionalCleanup, bin } from "./bins.ts";
import { PlainFunction } from "./types.ts";

export function value<T>(val?: T) {
    const cell = new Cell<T>;
    cell.value = val;
    function get() { return cell.getValue(); }
    get.set = cell.setValue.bind(cell);
    return get;
}

export function cached<T>(compute: (old: T) => T, initial?: T) {
    const cell = new Cell<T>;
    cell.value = initial;
    cell.compute = compute;
    cell.ctx = makeCtx(null, null, cell);
    cell.flags = Is.Lazy | Is.Detached;
    return cell.getValue.bind(cell);
}

/**
 * Subscribe a function to run every time certain values change.
 *
 * The function is run asynchronously, first after being created, then again
 * after there are changes in any of the values or cached functions it read
 * during its previous run.
 *
 * The created subscription is tied to the currently-active bin (usually that of
 * the enclosing flow).  So when that bin is cleaned up (or the flow ended), the
 * effect will be terminated automatically.  You can also terminate it early by
 * calling the "stop" function that is both passed to the effect function and
 * returned by `effect()`.
 *
 * Note: this function will throw an error if called outside of a `bin()`,
 * `bin.run()`, or another flow (i.e. another `job()`, `when()`, or `effect()`).
 * If you need a standalone effect, use {@link effect.root} instead.
 *
 * @param fn The function that will be run each time its dependencies change. It
 * is passed a single argument: a function that can be called to terminate the
 * effect.
 *
 * @returns A function that can be called to terminate the effect.
 */
export function effect(fn: (stop: () => void) => OptionalCleanup): () => void {
    return mkEffect(fn, bin);
}

/**
 * Create a standalone ("root") effect that won't be tied to the current
 * bin/flow (and thus doesn't *need* an enclosing bin or flow)
 *
 * Just like a plain `effect()` except that the effect is *not* tied to the
 * current flow or bin, and will therefore remain active until the disposal
 * callback is called, even if the enclosing bin is cleaned up or flow is
 * canceled.
 */
effect.root = function(fn: (stop: () => void) => OptionalCleanup): () => void {
    return mkEffect(fn, null);
}

function mkEffect(fn: (stop: () => void) => OptionalCleanup, parent: ActiveBin) {
    if (parent) unlink = parent.addLink(stop);
    var cell = new Cell;
    cell.compute = fn.bind(null, stop);
    cell.ctx = makeCtx(current.job, bin(), cell);
    cell.flags = Is.Effect | Is.Dirty;
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

export function untracked<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    const old = current.cell;
    if (!old) return fn(...args);
    try { current.cell = null; return fn(...args); } finally { current.cell = old; }
}

const effectQueue = new Set<Cell>;
var toUpdate = new Map<Cell, any>();
var timestamp = 1;
var runningEffects = false;
var loopCount = 0;

export function runEffects() {
    if (runningEffects) return;
    runningEffects = true;
    loopCount = 0;
    try {
        while(effectQueue.size || toUpdate.size) {
            ++loopCount
            // run effects marked dirty by value changes
            for(const e of effectQueue) e.catchUp();
            effectQueue.clear();
            ++timestamp;
            // update any values changed by the effects
            for(const [c,v] of toUpdate) c.updateValue(v);
            toUpdate.clear();
        }
    } finally {
        loopCount = 0;
        runningEffects = false;
        if (effectQueue.size || toUpdate.size) scheduleEffects();
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
    for(; cell; cell = dirtyStack.pop()) {
        for (const sub of cell.subscribers) {
            var flags = sub.flags;
            if (flags & Is.Dirty) continue;
            if (flags & Is.Effect) effectQueue.add(sub);
            sub.flags |= Is.Dirty;
            if (sub.subscribers) dirtyStack.push(sub);
        }
    }
}


const enum Is {
    Effect = 1 << 0,
    Dirty  = 1 << 1,
    Lazy   = 1 << 2,
    Dead   = 1 << 3,
    Detached = 1 << 4,
    Running = 1 << 5,
    NeedRecalc = Dirty | Detached
}

const freesets: Set<Cell>[] = [];

export class Cell<T=any> {
    value: T
    lastRecalc = 0;
    lastChanged = 0;
    flags = 0;
    sources: Set<Cell>;
    subscribers: Set<Cell>;
    ctx: Context;
    compute: (val?: T) => any

    getValue() {
        if (timestamp > this.lastRecalc && this.flags & Is.NeedRecalc) this.catchUp();
        const dep = current.cell;
        if (dep && dep !== this) {
            if (this.flags & Is.Running) throw new Error("Cached function dependency cycle");
            const sources = dep.sources || (dep.sources = freesets.pop() || new Set);
            sources.has(this) || (
                sources.add(this), ((dep.flags & Is.Detached) || this.subscribe(dep))
            )
        }
        return this.value;
    }

    setValue(val: T) {
        const cell = current.cell;
        if (cell) {
            if (cell.flags & Is.Lazy) throw new Error("Side-effects not allowed");
            if (this.subscribers && this.subscribers.has(cell)) throw new Error("Circular update error");
            if (loopCount>100) throw new Error("Indirect update cycle detected");
            // queue update for second half of current batch
            toUpdate.set(this, val);
        } else if (val !== this.value) {
            // outside batch or effect; apply immediately
            this.value = val;
            this.lastChanged = ++timestamp;
            // mark dirty now so cached funcs will return correct values
            if (this.subscribers) markDependentsDirty(this);
            scheduleEffects();
        }
    }

    updateValue(val: T) {
        if (val !== this.value) {
            this.value = val;
            this.lastChanged = timestamp;
            if (this.subscribers) markDependentsDirty(this);
        }
    }

    catchUp() {
        this.flags &= ~Is.Dirty;
        if (this.sources) {
            const {lastRecalc} = this;
            for (const s of this.sources) {
                if (timestamp > s.lastRecalc && s.flags & Is.NeedRecalc) s.catchUp();
                if (s.lastChanged > lastRecalc) {
                    return this.doRecalc();
                }
            }
        } else {
            return this.doRecalc();
        }
    }

    doRecalc() {
        this.lastRecalc = timestamp;
        const oldCtx = swapCtx(this.ctx);
        const oldSources = this.sources;
        this.sources = undefined;
        this.flags |= Is.Running;
        try {
            if (this.flags & Is.Lazy) {
                const future = (0, this.compute)(this.value);
                if (future !== this.value || !this.lastChanged) {
                    this.value = future;
                    this.lastChanged = timestamp;
                }
            } else if (this.flags & Is.Dead) {
                // no-op
            } else if (this.flags & Is.Effect) {
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
            if (oldSources) {
                const sources = this.sources;
                oldSources.forEach(s => sources?.has(s) || s.unsubscribe(this));
                oldSources.clear();
                freesets.push(oldSources);
            }
            if (this.flags & Is.Dead && this.ctx.bin) {
                this.ctx.bin.destroy();
                this.ctx.bin = null;
            }
        }
    }

    disposeEffect() {
        if (this.flags & Is.Dead) return;
        this.flags |= Is.Dead;
        if (current === this.ctx) {
            // Currently calculating; do prelim work here
            this.ctx.cell = null;
            this.sources?.forEach(s => s.unsubscribe(this));
            this.sources?.clear();
            this.sources = undefined;
        } else {
            this.doRecalc();
        }
    }

    subscribe(subscriber: Cell) {
        (this.subscribers ||= freesets.pop() || new Set).add(subscriber);
        if (this.flags & Is.Lazy && this.subscribers.size === 1) {
            this.flags &= ~Is.Detached;
            if (this.sources) for(const s of this.sources) s.subscribe(this);
        }
    }

    unsubscribe(subscriber: Cell) {
        this.subscribers?.delete(subscriber);
        if (this.flags & Is.Lazy && !this.subscribers.size) {
            this.flags |= Is.Detached;
            if (this.sources) for(const s of this.sources) s.unsubscribe(this);
        }
    }
}
