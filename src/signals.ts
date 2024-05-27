import { current, freeCtx, makeCtx, swapCtx } from "./ambient.ts";
import { PlainFunction, Yielding, RecalcSource, AnyFunction } from "./types.ts";
import { Cell } from "./cells.ts";
import { rule } from "./rules.ts";
import { reject, resolve } from "./results.ts";
import { UntilMethod } from "./sinks.ts";
import { SignalSource, Source } from "./streams.ts";
import { CallableObject } from "./utils.ts";
import { defer } from "./defer.ts";

export { rule, runRules, type GenericMethodDecorator, type RuleFactory } from "./rules.ts"
export { WriteConflict, CircularDependency } from "./cells.ts";

/**
 * An observable value, as a zero-argument callable with extra methods.
 *
 * In addition to being callable, signals also offer a `.value` getter, and
 * implement the standard JS methods `.toString()`, `.valueOf()`, and
 * `.toJSON()` in such a way that they reflect the signal's contents rather than
 * the signal itself.
 *
 * Signals also implement the {@link Source} interface, and can thus be
 * subscribed to.  Subscribers receive the current value first, and then any
 * changes thereafter.  They can be waited on by {@link until}(), in which case
 * the calling job resumes when the signal's value is truthy.
 *
 * You can also transform a signal to a {@link Writable} by calling its
 * .{@link Signal.withSet withSet}() method, or create a writable value using
 * {@link value}().
 *
 * @category Types and Interfaces
 */
export interface Signal<T> extends SignalSource<T>, UntilMethod<T> {
    /**
     * The current value
     *
     * @category Reading
     */
    readonly value: T

    /** Current value @hidden */
    valueOf()  : T

    /** Current value as a string @hidden */
    toString(): string

    /** The current value @hidden */
    toJSON()   : T

    /**
     * Get the signal's current value, without adding the signal as a dependency
     *
     * (This is exactly equivalent to calling {@link peek}(signal), and exists
     * here mainly for interop with other signal frameworks.)
     *
     *  @category Reading */
    peek(): T;

    /** Get a read-only version of this signal @category Reading */
    asReadonly(): Signal<T>

    /** New writable signal with a custom setter @category Writing */
    withSet(set: (v: T) => unknown): Writable<T>

    /** @hidden */
    "uneventful.until"(): Yielding<T>;
}

/** @internal */
export class SignalImpl<T> extends CallableObject<SignalSource<T>> implements Signal<T> {
    constructor(protected _c: Cell) { super(_c.getValue.bind(_c)); }
    get value() { return this(); }
    valueOf()   { return this(); }
    toString()  { return "" + this(); }
    toJSON()    { return this(); }
    peek()      { return peek(this as () => T); };
    asReadonly(): Signal<T> { return this; }
    withSet(set: (v: T) => unknown): Writable<T> {
        return Object.assign(new WritableImpl<T>(this._c), {set});
    }

    *"uneventful.next"(): Yielding<T> {
        return yield (r => {
            let seen = false, res: T;
            rule(stop => {
                try { res = this(); } catch(e) { stop(); defer(reject.bind(null, r,e)); }
                if (seen) { stop(); defer(resolve.bind(null, r, res)); }
                seen = true;
            })
        });
    }

    *"uneventful.until"(): Yielding<T> {
        return yield (r => {
            let res: T;
            try { res = this(); } catch(e) { reject(r, e); return; }
            if (res) return resolve(r, res);
            rule(stop => {
                try { res = this(); } catch(e) { stop(); defer(reject.bind(null, r,e)); }
                if (res) { stop(); defer(resolve.bind(null, r, res)); }
            });
        });
    }
}

/**
 * A {@link Signal} with a {@link Writable.set | .set()} method and writable
 * {@link Writable.value | .value} property.
 *
 * @category Types and Interfaces
 */
export interface Writable<T> extends Signal<T>  {
    /**
     * Set the current value.  (Note: this is a bound method so it can be used
     * as a callback.)
     *
     * @category Writing
     */
    readonly set: (val: T) => void;

    get value(): T

    /** Set the current value */
    set value(val: T);
}

/** @internal */
export class WritableImpl<T> extends SignalImpl<T> implements Writable<T> {
    get value() { return this(); }
    set value(val: T) { this.set(val); }
    set = (val: T) => { this._c.setValue(val, false); }
    asReadonly(): Signal<T> {
        return new SignalImpl<T>(this._c);
    }
}

/**
 * A writable signal that can be set to either a value or an expression.
 *
 * Like a spreadsheet cell, a configurable signal can contain either a value or
 * a formula.  If you .set() a value or change the .value property of the
 * signal, the formula is cleared.  Conversely, if you set a formula with
 * .setf(), then the value is calculated using that formula from then on, until
 * another formula is set, or the value is changed directly again.
 *
 * @category Types and Interfaces
 */
export interface Configurable<T> extends Writable<T>  {
    /**
     * Set a formula that will be used to calculate the signal's value. If it
     * uses the value of other signals, this signal's value will be recalculated
     * when they change.
     *
     * @category Writing
     */
    setf(expr: () => T): this;
}

/** @internal */
export class ConfigurableImpl<T> extends WritableImpl<T> implements Configurable<T> {
    setf(expr: () => T): this {
        this._c.setCalc(expr);
        return this;
    }
}

/**
 * Create a {@link Configurable} signal with the given inital value
 *
 * @category Signals
 */
export function value<T>(val?: T): Configurable<T> {
    const cell = Cell.mkValue(val);
    return new ConfigurableImpl<T>(cell);
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
 * source, triggering rules or events as appropriate if the value changes.  When
 * the signal is once again unobserved (or if the source ends without an error),
 * its value will revert to the supplied default.
 *
 * If the source ends *with* an error, however, then the cached function will
 * throw that error whenever called, until/unless it becomes unobserved again.
 * (And thus reverts to the default value once more.)
 *
 * @param source A {@link Source} providing data which will become this signal's
 * value
 * @param defaultVal The value to use when the signal is unobserved or waiting for
 * the first item from the source.
 */
export function cached<T>(source: Source<T>, defaultVal?: T): Signal<T>;
export function cached<T extends Signal<any>>(signal: T): T
export function cached<T>(compute: Source<T> | (() => T), initVal?: T): Signal<T> {
    if (compute instanceof SignalImpl) return compute;
    return new SignalImpl<T>(
        compute.length ? Cell.mkStream(compute as Source<T>, initVal) : Cell.mkCached(compute as () => T)
    );
}

/**
 * Call a function without creating a dependency on any signals it reads.  (Like
 * {@link Signal.peek}, but for any function with any arguments.)
 *
 * You can also pass in any arguments the function takes, and the function's
 * return value is returned.
 *
 * (Note: Typed overloads are not supported: TypeScript will use the function's
 * *last* overload for argument-typing purposes.  If you need to call a function
 * with a specific overload, wrap the function with {@link action}() instead, and
 * then TypeScript will be able to detect which overload you're using.)
 *
 * @returns The result of calling `fn(..args)`
 *
 * @category Signals
 */
export function peek<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
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
 * version (i.e. `recalcWhen(someObj, factory)`, where `factory` is a function
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
 * {@link RecalcSource}.  (Note that this factory function must also be a static
 * function, not a closure, or the same memory thrash issue will occur!)
 */
export function recalcWhen<T extends WeakKey>(key: T, factory: (key: T) => RecalcSource): void;
export function recalcWhen<T extends WeakKey>(fnOrKey: T | RecalcSource, fn?: (key: T) => RecalcSource) {
    current.cell?.recalcWhen<T>(fnOrKey as T, fn);
}

/**
 * Wrap a function (or decorate a method) so that signals it reads are not added
 * as dependencies to the current rule (if any).  (Basically, it's shorthand for
 * wrapping the function or method body in a giant call to {@link peek}().)
 *
 * So, instead of writing an action function like this:
 *
 * ```ts
 * function outer(arg1, arg2) {
 *     return peek(() => {
 *         // reactive values used here will not be added to the running rule
 *     })
 * }
 * ```
 * you can just write this:
 * ```ts
 * const outer = action((arg1, arg2) => {
 *     // reactive values used here will not be added to the running rule
 * });
 * ```
 * or this:
 * ```ts
 * class Something {
 *     ⁣⁣@action  // auto-detects TC39 or legacy decorators
 *     someMethod(arg1) {
 *         // reactive values used here will not be added to the running rule
 *     }
 * }
 * ```
 *
 * @param fn The function to wrap.  It can take any arguments or return value,
 * and overloads are supported.  However, any non-standard properties the
 * function may have had will *not* be present on the wrapped function, even if
 * TypeScript will act as if they are!
 *
 * @returns A wrapped version of the function that passes through its arguments
 * to the original function, while running with dependency tracking suppressed
 * (as with {@link peek}()).
 *
 * @category Signals
 */
export function action<F extends AnyFunction>(fn: F): F;

/** @hidden TC39 Decorator protocol */
export function action<F extends AnyFunction>(fn: F, ctx: {kind: "method"}): F;

/** @hidden Legacy Decorator protocol */
export function action<F extends AnyFunction, D extends {value?: F}>(
    clsOrProto: any, name: string|symbol, desc: D
): D

export function action<F extends AnyFunction, D extends {value?: F}>(fn: F, _ctx?: any, desc?: D): D | F {
    if (desc) return {...desc, value: action(desc.value)};
    return <F> function (this: ThisParameterType<F>) {
        if (!current.cell) return fn.apply(this, arguments as any);
        const old = swapCtx(makeCtx(current.job));
        try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
    }
}
