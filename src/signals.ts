import { current } from "./ambient.ts";
import { DisposeFn, OptionalCleanup, flow } from "./tracking.ts";
import { PlainFunction } from "./types.ts";
import { Cell, EffectScheduler } from "./cells.ts";
import { defer } from "./defer.ts";
export { type EffectScheduler } from "./cells.ts";

export interface Signal<T> {
    /** A signal object can be called to get its current value */
    (): T
}

/**
 * An observable value, as a zero-argument callable with extra methods.
 *
 * Note: this class is not directly instantiable - use {@link cached}() or call
 * {@link readonly |.readonly()} on an existing signal instead.
 *
 * @category Types and Interfaces
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
    /** Get the signal's current value, without adding the signal as a dependency */
    peek()      { return noDeps(this as () => T); };

    /** Get a read-only version of this signal */
    readonly(): Signal<T> { return this; }

    /** New writable signal with a custom setter */
    withSet(set: (v: T) => unknown) { return mkSignal(() => this(), set); }

    protected constructor() { super(); }
}

export interface Writable<T> {
    /** Set the current value.  (Note: this is a bound method so it can be used as a callback.) */
    set(val: T): void;
}

/**
 * A {@link Signal} with a {@link Writable.set | .set()} method and writable
 * {@link Writable.value | .value} property.
 *
 * Note: this class is not directly instantiable - use {@link value}() or call
 * {@link Signal.withSet | .withSet()} on an existing signal instead.
 *
 * @category Types and Interfaces
 */
export class Writable<T> extends Signal<T>  {
    get value() { return this(); }
    set value(val: T) { this.set(val); }
    readonly() { return mkSignal(() => this()); }
}

/**
 * Create a {@link Writable} signal with the given inital value
 *
 * @category Signals
 */
export function value<T>(val?: T): Writable<T> {
    const cell = Cell.mkValue(val);
    return mkSignal(cell.getValue.bind(cell), cell.setValue.bind(cell));
}

/**
 * Create a cached version of a function.  The returned callable is also a {@link Signal}.
 *
 * @category Signals
 */
export function cached<T>(compute: () => T): Signal<T>
export function cached<T extends Signal<any>>(signal: T): T
export function cached<T>(compute: () => T): Signal<T> {
    if (compute instanceof Signal) return compute;
    return mkSignal(Cell.mkCached(compute));
}

/**
 * Subscribe a function to run every time certain values change.
 *
 * The function is run asynchronously, first after being created, then again
 * after there are changes in any of the values or cached functions it read
 * during its previous run.
 *
 * The created subscription is tied to the currently-active flow.  So when that
 * flow is ended or restarted, the effect will be terminated automatically.  You
 * can also terminate it early by calling the "stop" function that is both
 * passed to the effect function and returned by `effect()`.
 *
 * Note: this function will throw an error if called without an active flow. If
 * you need a standalone effect, use {@link effect.root} (or
 * {@link EffectScheduler.root effect.scheduler().root()}) instead.
 *
 * @param fn The function that will be run each time its dependencies change.
 * The function will be run in a fresh flow each time, with any resources used
 * by the previous run being cleaned up.  The function is passed a single
 * argument: a function that can be called to terminate the effect.   The
 * function should return a cleanup function or void.
 *
 * @returns A function that can be called to terminate the effect.
 *
 * @category Signals
 * @category Flows
 */
export function effect(fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn {
    return Cell.mkEffect(fn, flow);
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
     * flow (and thus doesn't *need* an enclosing flow).
     *
     * Just like a plain {@link effect}() or {@link EffectScheduler.effect}(),
     * except that the effect is *not* tied to the current flow, and will
     * therefore remain active until the "stop" function or dispose callback is
     * called, even if the enclosing flow is ended or restarted.
     */
    export function root(fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn {
        return Cell.mkEffect(fn, null);
    }
    /**
     * Create an {@link EffectScheduler} from a callback-taking function, that
     * you can then use to make effects that run in a specific time frame.
     *
     * ```ts
     * // frame.effect and frame.root will now create nested or root effects
     * const frame = effect.scheduler(requestAnimationFrame);
     *
     * frame.effect(() => {
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
     * some future point, when it is the desired time for all pending effects on
     * that scheduler to run.
     */
    export function scheduler(scheduleFn: (callback: () => unknown) => unknown = defer) {
        return EffectScheduler.for(scheduleFn);
    }
}

/**
 * Call a function without creating a dependency on any signals it reads.  (Like
 * {@link Signal.peek}, but for any function with any arguments.)
 *
 * You can also pass in any arguments the function takes, and the function's
 * return value is returned.
 *
 * @returns The result of calling `fn(..args)`
 *
 * @category Signals
 */
export function noDeps<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    const old = current.cell;
    if (!old) return fn(...args);
    try { current.cell = null; return fn(...args); } finally { current.cell = old; }
}


function mkSignal<T>(get: () => T): Signal<T>
function mkSignal<T>(get: () => T, set: (v: T) => void): Writable<T>
function mkSignal<T>(get: () => T, set?: (v: T) => void) {
    if (set) get["set"] = set;
    return Object.setPrototypeOf(get, (set ? Writable : Signal).prototype);
}
