import { current } from "./ambient.ts";
import { OptionalCleanup, tracker } from "./bins.ts";
import { PlainFunction } from "./types.ts";
import { Cell, mkEffect, mkCached } from "./cells.ts";

export interface Signal<T> {
    /** A signal object can be called to get its current value */
    (): T
}

/**
 * A value or cached function (note: not directly instantiable)
 *
 * @category Signals
 */
export class Signal<T> extends Function {
    /** The current value */
    get value() { return this(); }
    /** The current value */
    valueOf()   { return this(); }
    /** The current value, as a string */
    toString()  { return "" + this(); }
    /** The current value */
    toJSON()    { return this(); }
    /** The current value, but without dependency tracking */
    peek()      { return untracked(this as () => T); };
}

export interface Writable<T> {
    /** Set the current value.  (Note: this is a bound method so it can be used as a callback.) */
    set(val: T): void;
}

/**
 * A writable signal (note: not directly instantiable)
 *
 * @category Signals
 */
export class Writable<T> extends Signal<T>  {
    get value() { return this(); }
    set value(val: T) { this.set(val); }
    update(fn: (val: T) => T) { return this.set(fn(untracked(this as () => T))); }
}

/**
 * Create a {@link Writable} signal with the given inital value
 *
 * @category Signals
 */
export function value<T>(val?: T): Writable<T> {
    const cell = new Cell<T>;
    cell.value = val;
    cell.validThrough = Infinity;
    const get = cell.getValue.bind(cell) as Writable<T>;
    get.set = cell.setValue.bind(cell);
    return Object.setPrototypeOf(get, Writable.prototype) as Writable<T>;
}

/**
 * Create a cached version of a function.  The returned callable is also a {@link Signal}.
 *
 * @category Signals
 */
export function cached<T>(compute: (old: T) => T, initial?: T): Signal<T>
export function cached<T extends Signal<any>>(signal: T): T
export function cached<T>(compute: (old: T) => T, initial?: T): Signal<T> {
    if (compute instanceof Signal) return compute;
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
 * If you need a standalone effect, use **{@link effect.root}** instead.
 *
 * @param fn The function that will be run each time its dependencies change. It
 * is passed a single argument: a function that can be called to terminate the
 * effect.
 *
 * @returns A function that can be called to terminate the effect.
 *
 * @category Signals
 * @category Flows
 */
export function effect(fn: (stop: () => void) => OptionalCleanup): () => void {
    return mkEffect(fn, tracker);
}

/**
 * Static methods of {@link effect}
 *
 * @category Signals
 * @category Flows
 */
export namespace effect {
    /**
     * Create a standalone ("root") effect that won't be tied to the current
     * bin/flow (and thus doesn't *need* an enclosing bin or flow)
     *
     * Just like a plain `effect()` except that the effect is *not* tied to the
     * current flow or bin, and will therefore remain active until the disposal
     * callback is called, even if the enclosing bin is cleaned up or flow is
     * canceled.
     */
    export function root(fn: (stop: () => void) => OptionalCleanup): () => void {
        return mkEffect(fn, null);
    }
}

/**
 * Run a function without tracking signals it depends on, even if a cached
 * function or effect is calling it.
 *
 * You can also pass in any arguments the function takes, and the function's
 * return value is returned.
 *
 * @category Signals
 */
export function untracked<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    const old = current.cell;
    if (!old) return fn(...args);
    try { current.cell = null; return fn(...args); } finally { current.cell = old; }
}
