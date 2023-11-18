import { current } from "./ambient.ts";
import { OptionalCleanup, bin } from "./bins.ts";
import { PlainFunction } from "./types.ts";
import { Cell, mkEffect, mkCached } from "./cells.ts";

export interface Signal<T> {
    (): T
}

export class Signal<T> extends Function {
    get value() { return this(); }
    valueOf()   { return this(); }
    toString()  { return "" + this(); }
    toJSON()    { return this(); }
    peek()      { return untracked(this as () => T); };
}

export interface Writable<T> extends Signal<T> {
    set: (val: T) => void;
}

export class Writable<T> extends Signal<T>  {
    get value() { return this(); }
    set value(val: T) { this.set(val); }
    update(fn: (val: T) => T) { return this.set(fn(untracked(this as () => T))); }
}

export function value<T>(val?: T): Writable<T> {
    const cell = new Cell<T>;
    cell.value = val;
    cell.validThrough = Infinity;
    const get = cell.getValue.bind(cell) as Writable<T>;
    get.set = cell.setValue.bind(cell);
    return Object.setPrototypeOf(get, Writable.prototype) as Writable<T>;
}

export function cached<T>(compute: (old: T) => T, initial?: T) {
    return Object.setPrototypeOf(mkCached(compute, initial), Signal.prototype) as Signal<T>;
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

export function untracked<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    const old = current.cell;
    if (!old) return fn(...args);
    try { current.cell = null; return fn(...args); } finally { current.cell = old; }
}
