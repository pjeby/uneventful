import { current, freeCtx, makeCtx, swapCtx } from "./ambient.ts";
import { PlainFunction, Yielding } from "./types.ts";
import { Cell, rule } from "./cells.ts";
import { reject, resolve } from "./results.ts";
import { UntilMethod } from "./sinks.ts";
export { RuleScheduler, rule, runRules, WriteConflict, CircularDependency } from "./cells.ts";

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
export class Signal<T> extends Function implements UntilMethod<T> {
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

    *"uneventful.until"(): Yielding<T> {
        return yield (r => {
            try {
                let res: T = this.peek();
                if (res) resolve(r, res); else rule(() => {
                    try { (res = this()) && resolve(r, res); } catch(e) { reject(r,e); }
                })
            } catch(e) {
                reject(r, e);
            }
        });
    }

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
    if (!current.cell) return fn(...args);
    const old = swapCtx(makeCtx(current.job));
    try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
}


function mkSignal<T>(get: () => T): Signal<T>
function mkSignal<T>(get: () => T, set: (v: T) => void): Writable<T>
function mkSignal<T>(get: () => T, set?: (v: T) => void) {
    if (set) (get as Writable<T>)["set"] = set;
    return Object.setPrototypeOf(get, (set ? Writable : Signal).prototype);
}
