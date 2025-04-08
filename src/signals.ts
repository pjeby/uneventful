/**
 * The Signals API for uneventful.
 *
 * @module uneventful/signals
 */

import { currentCell } from "./ambient.ts";
import { PlainFunction, Yielding, AnyFunction, Job } from "./types.ts";
import { Cell, getCell } from "./cells.ts";
import { rule } from "./rules.ts";
import { reject, resolve } from "./results.ts";
import { UntilMethod } from "./sinks.ts";
import { SignalSource, Source, Stream } from "./streams.ts";
import { callOrWait } from "./call-or-wait.ts";
import { CallableObject, apply, arrayEq } from "./utils.ts";
import { defer } from "./defer.ts";
import { next } from "./sinks.ts";  // needed for documentation link

export type * from "./rules.ts"
export { rule, runRules } from "./rules.ts"
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
            rule(() => {
                try { res = this(); } catch(e) { rule.stop(); defer(reject.bind(null, r,e)); }
                if (seen) { rule.stop(); defer(resolve.bind(null, r, res)); }
                seen = true;
            })
        });
    }

    *"uneventful.until"(): Yielding<T> {
        return yield (r => {
            let res: T;
            try { res = this(); } catch(e) { reject(r, e); return; }
            if (res) return resolve(r, res);
            rule(() => {
                try { res = this(); } catch(e) { rule.stop(); defer(reject.bind(null, r,e)); }
                if (res) { rule.stop(); defer(resolve.bind(null, r, res)); }
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

    value: T

    /**
     * Update the current value with a patch function
     *
     * Note: this reads the signal's current value, which may produce a write
     * conflict or circular dependency if you call it from inside a rule.
     *
     * @category Writing
     */
    edit(patch: (before: T) => T): void;
}

/** @internal */
export class WritableImpl<T> extends SignalImpl<T> implements Writable<T> {
    get value() { return this(); }
    set value(val: T) { this.set(val); }
    set = (val: T) => { this._c.setValue(val, false); }
    asReadonly(): Signal<T> {
        return new SignalImpl<T>(this._c);
    }
    edit(patch: (before: T) => T) {
        this.set(patch(this()))
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
 * @category none
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
 * @category none
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
 * @category Dependency Tracking
 */
export function peek<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    return currentCell ? currentCell.peek(fn, null, args) : fn(...args);
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
 * @category Dependency Tracking
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
    return <F> function (this: ThisParameterType<F>, ...args) {
        return currentCell ? currentCell.peek(fn, this, args) : apply(fn, this, args)
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
 * @category Dependency Tracking
 */

export function unchangedIf<T>(newVal: T, equals: (v1: T, v2: T) => boolean = arrayEq): T {
    return getCell("unchangedIf() ").unchangedIf(newVal, equals)
}

/**
 * Wait for and return the next truthy value (or error) from a data source (when
 * processed with `yield *` within a {@link Job}).
 *
 * This differs from {@link next}() in that it waits for the next "truthy" value
 * (i.e., not null, false, zero, empty string, etc.), and when used with signals
 * or a signal-using function, it can resume *immediately* if the result is
 * already truthy.  (It also supports zero-argument signal-using functions,
 * automatically wrapping them with {@link cached}(), as the common use case for
 * until() is to wait for an arbitrary condition to be satisfied.)
 *
 * @param source The source to wait on, which can be:
 * - An object with an `"uneventful.until"` method returning a {@link Yielding}
 *   (in which case the result will be the the result of calling that method)
 * - A {@link Signal}, or a zero-argument function returning a value based on
 *   signals (in which case the job resumes as soon as the result is truthy,
 *   perhaps immediately)
 * - A {@link Source} (in which case the job resumes on the next truthy value
 *   it produces
 *
 * (Note: if the supplied source is a function with a non-zero `.length`, it is
 * assumed to be a {@link Source}.)
 *
 * @returns a Yieldable that when processed with `yield *` in a job, will return
 * the triggered event, or signal value.  An error is thrown if event stream
 * throws or closes early, or the signal throws.
 *
 * @category Scheduling
 */

export function until<T>(source: UntilMethod<T> | Stream<T> | (() => T)): Yielding<T> {
    return callOrWait<T>(source, "uneventful.until", waitTruthy, recache);
}
function recache<T>(s: () => T) { return until(cached(s)); }
function waitTruthy<T>(job: Job<T>, v: T) { v && job.return(v); }
