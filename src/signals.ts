import { current, freeCtx, makeCtx, swapCtx } from "./ambient.ts";
import { PlainFunction, Yielding, RecalcSource } from "./types.ts";
import { Cell, rule } from "./cells.ts";
import { reject, resolve } from "./results.ts";
import { UntilMethod } from "./sinks.ts";
import { Connection, Inlet, IsStream, Sink, Source, Producer } from "./streams.ts";
export { RuleScheduler, rule, runRules, WriteConflict, CircularDependency } from "./cells.ts";

export interface Signal<T> {
    /**
     * A signal object implements the {@link Producer} interface, even if it's
     * not directly recognized as one by TypeScript.
     */
    (sink: Sink<T>, conn?: Connection, inlet?: Inlet): typeof IsStream

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
    withSet(set: (v: T) => unknown) {
        const that = this;
        return mkSignal( function () { return that.apply(null, arguments); }, set);
    }

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
    readonly(): Signal<T> {
        const that = this;
        return mkSignal<T>( function () { return that.apply(null, arguments); });
    }
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
 * Create a cached version of a function.  The returned callable is also a
 * {@link Signal}.
 *
 * Note: If the supplied function has a non-zero `.length` (i.e., it explicitly
 * takes arguments), it is assumed to be a {@link Source}, and the second
 * calling signature below will apply, even if TypeScript doesn't see it that
 * way!)
 *
 * @category Signals
 */
export function cached<T>(compute: () => T): Signal<T>;

/**
 * If the supplied function has a non-zero `.length` (i.e., it explicitly takes
 * arguments), it is assumed to be a {@link Source}, and the second argument is
 * a default value for the created signal to use as default value until the
 * source produces a value.
 *
 * The source will be subscribed *only* while the signal is subscribed as a
 * stream, or observed (directly or indirectly) by a rule.  While subscribed,
 * the signal will update itself with the most recent value produced by the
 * source, triggering rules or events as appropriate if the value changes. When
 * the signal is once again unobserved, it will revert to the supplied inital
 * value.
 *
 * @param source A {@link Source} providing data which will become this signal's value
 * @param initVal The value to use when the signal is unobserved or waiting for the
 * first item from the source.
 */
export function cached<T>(source: Source<T>, initVal?: T): Signal<T>;
export function cached<T extends Signal<any>>(signal: T): T
export function cached<T>(compute: Source<T> | (() => T), initVal?: T): Signal<T> {
    if (compute instanceof Signal) return compute;
    return mkSignal(
        compute.length ? Cell.mkStream(compute as Producer<T>, initVal) : Cell.mkCached(compute as () => T)
    );
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

/**
 * Arrange for the current signal or rule to recalculate on demand
 *
 * This lets you interop with systems that have a way to query a value and
 * subscribe to changes to it, but not directly produce a signal.  (Such as
 * querying the DOM state and using a MutationObserver.)
 *
 * By calling this with a {@link Source} or {@link RecalcSource}, you arrange
 * for it to be subscribed, if and when the call occurs in a rule or a cached
 * function that's in use by a rule (directly or indirectly).  When the source
 * emits a value, the signal machinery will invalidate the caching of the
 * function or rule, forcing a recalculation and subsequent rule reruns, if
 * applicable.
 *
 * Note: you should generally only call the 1-argument version of this function
 * with "static" sources - i.e. ones that won't change on every call. Otherwise,
 * you will end up creating new signals each time, subscribing and unsubscribing
 * on every call to recalcWhen().
 *
 * If the source needs to reference some object, it's best to use the 2-argument
 * version (i.e. `changesWhen(someObj, factory)`, where `factory` is a function
 * that takes `someObj` and returns a suitable {@link RecalcSource}.)
 *
 * @remarks
 * recalcWhen is specifically designed so that using it does not pull in any
 * part of Uneventful's signals framework, in the event a program doesn't
 * already use it.  This means you can use it in library code to provide signal
 * compatibility, without adding bundle bloat to code that doesn't use signals.
 *
 * @category Signals
 */
export function recalcWhen(src: RecalcSource): void;
/**
 * Two-argument variant of recalcWhen
 *
 * In certain circumstances, you may wish to use recalcWhen with a source
 * related to some object.  You could call recalcWhen with a closure, but that
 * would create and discard signals on every call.  So this 2-argument version
 * lets you avoid that by allowing the use of an arbitrary object as a key,
 * along with a factory function to turn the key into a {@link RecalcSource}.
 *
 * @param key an object to be used as a key
 *
 * @param factory a function that will be called with the key to obtain a
 * {@link RecalcSource}.  Note that this factory function must also be a static
 * function, not a closure, or the same memory thrash issue will occur.
 */
export function recalcWhen<T extends WeakKey>(key: T, factory: (key: T) => RecalcSource): void;
export function recalcWhen<T extends WeakKey>(fnOrKey: T | RecalcSource, fn?: (key: T) => RecalcSource) {
    current.cell?.recalcWhen<T>(fnOrKey as T, fn);
}

function mkSignal<T>(get: () => T): Signal<T>
function mkSignal<T>(get: () => T, set: (v: T) => void): Writable<T>
function mkSignal<T>(get: () => T, set?: (v: T) => void) {
    if (set) (get as Writable<T>)["set"] = set;
    return Object.setPrototypeOf(get, (set ? Writable : Signal).prototype);
}
