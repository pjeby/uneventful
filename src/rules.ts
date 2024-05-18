import { defer } from "./defer.ts";
import { RuleQueue, currentRule, defaultQ, ruleQueue } from "./scheduling.ts";
import { AnyFunction, DisposeFn, OptionalCleanup } from "./types.ts";
import { Cell } from "./cells.ts";
import { CallableObject, setMap } from "./utils.ts";

/**
 * A decorator function that supports both TC39 and "legacy" decorator protocols
 *
 * @template F the type of method this decorator can decorate.  If the method
 * doesn't conform to this type, compile-time type checks will fail.
 *
 * @category Types and Interfaces
 */
export type GenericMethodDecorator<F extends AnyFunction> = {
    /** TC39 Method Decorator @hidden */
    (fn: F, ctx?: {kind: "method"}): F;

    /** Legacy Method Decorator @hidden */
    (proto: object, name: string|symbol, desc?: {value?: F}): void;
}

/**
 * The interface provided by {@link rule}, and other {@link rule.factory}()
 * functions.
*
* @category Types and Interfaces
*/
export interface RuleFactory {
    /**
     * @inheritdoc rule factory tied to a specific scheduler.  See {@link rule} for
     * more details.
     */
    (fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn;

    /**
     * Stop the currently-executing rule, or throw an error if no rule is
     * currently running.
     */
    stop(): void

    /**
     * Observe a condition and apply an action.
     *
     * This is roughly equivalent to `rule(() => { if (condition()) return
     * action(); })`, except that the rule is *only* rerun if the `action`'s
     * dependencies change, *or* the truthiness of `condition()` changes. It
     * will *not* be re-run if only the dependencies of `condition()` have
     * changed, without affecting its truthiness.
     *
     * This behavior can be important for rules that nest other rules, have
     * cleanups, fire off tasks, etc., as it may be wasteful to constantly tear
     * them down and set them back up if the enabling condition is a calculation
     * with frequently-changing dependencies.
     */
    if(condition: () => any, action: () => OptionalCleanup): DisposeFn

    /**
     * Decorate a method to behave as a rule, e.g.
     *
     * ```ts
     * const animate = rule.factory(requestAnimationFrame);
     *
     * class Draggable {
     *     ⁣@animate.method
     *     trackPosition(handleTop: number, handleLeft: number) {
     *         const {clientX, clientY} = lastMouseEvent();
     *         this.element.style.top  = `${clientY - handleTop}px`;
     *         this.element.style.left = `${clientX - handleLeft}px`;
     *     }
     * }
     *
     * // Start running the method in an animation frame for every change to
     * // lastMouseEvent, until the current job ends:
     * someDraggable.trackPosition(top, left);
     * ```
     *
     * Each time it's (explicitly) called, the decorated method will start a new
     * rule, which will repeatedly run the method body (with the original
     * arguments and `this`) whenever its dependencies change, according to the
     * schedule defined by the rule factory.  (So e.g. `@rule.method` will
     * update on the microtask after a change, etc.)
     *
     * The decorated method will always return a {@link DisposeFn} to let you
     * explicitly stop the rule before the current job end.  But if the original
     * method body doesn't return a dispose function of its own, TypeScript will
     * consider the method to return void, unless you explicitly declare its
     * return type to be `DisposeFn | void`.
     *
     * Also note that since rule methods can accept arbitrary parameters, they
     * do not receive a `stop` parameter, and must therefore use {@link
     * RuleFactory.stop rule.stop}() if they wish to terminate themselves.
     */
    readonly method: GenericMethodDecorator<(...args: any[]) => OptionalCleanup>

    /**
     * Return a rule factory for the given scheduling function, that you can
     * then use to make rules that run in a specific time frame.
     *
     * ```ts
     * // `animate` will now create rules that run during animation fames
     * const animate = rule.factory(requestAnimationFrame);
     *
     * animate(() => {
     *     // ... do stuff in an animation frame when signals used here change
     * })
     * ```
     *
     * (In addition to being callable, the returned function is also a
     * {@link RuleFactory}, and thus has a `.method` decorator, `.if()` method,
     * and so on.)
     *
     * @param scheduleFn A single-argument scheduling function (such as
     * requestAnimationFrame, setImmediate, or queueMicrotask).  The rule
     * scheduler will call it from time to time with a single callback.  The
     * scheduling function should then arrange for that callback to be invoked
     * *once* at some future point, when it is the desired time for all pending
     * rules on that scheduler to run.
     *
     * @returns A {@link RuleFactory}, like {@link rule}.  If called with the
     * same scheduling function more than once, it returns the same factory.
     *
     */
    factory(scheduleFn: (cb: () => unknown) => unknown): RuleFactory
}

class RF extends CallableObject<(fn: (stop: DisposeFn) => OptionalCleanup) => DisposeFn> implements RuleFactory {

    constructor(q: RuleQueue) {
        super((fn: (stop: DisposeFn) => OptionalCleanup): DisposeFn => Cell.mkRule(fn, q))
    }

    stop() {
        if (currentRule) return currentRule.disposeRule();
        throw new Error("No rule active");
    }
    if(condition: () => any, action: () => OptionalCleanup): DisposeFn {
        const cond = Cell.mkCached(() => !!condition());
        return this(() => cond() ? action() : undefined);
    }

    get method(): GenericMethodDecorator<(...args: any[]) => OptionalCleanup> {
        const self = this;
        return (
            fn: object | ((...args: any[]) => OptionalCleanup),
            _ctxOrName?: any,
            desc?: { value?: (...args: any[]) => OptionalCleanup; }
        ) => {
            if (desc) return void (desc.value = this.method(desc.value));
            return function (this: any, ...args: any[]): DisposeFn {
                return self(() => (fn as any).apply(this, args));
            };
        }
    }

    factory(scheduleFn: (cb: () => unknown) => unknown): RuleFactory {
        return factories.get(scheduleFn) || setMap(factories, scheduleFn, new RF(ruleQueue(scheduleFn)));
    }
}


const factories = new WeakMap<Function, RuleFactory>();

/**
 * Subscribe a function to run every time certain values change.
 *
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
export const rule: ((action: (stop: DisposeFn) => OptionalCleanup) => DisposeFn) & RuleFactory = (
    RF.prototype.factory(defer)
)

/**
 * Synchronously run any pending rules tied to a specific schedule.
 *
 * (Note: "pending" rules are ones with at least one changed ancestor
 * dependency; this doesn't mean they will actually *do* anything, since
 * intermediate cached() function results might end up unchanged.)
 *
 * You should normally only need to call this when you need to *force*
 * side-effects to occur within a specific *synchronous* timeframe, e.g. if
 * rules need to be able to cancel a synchronous event or continue an IndexedDB
 * transaction.  (Otherwise, this is really only useful for testing.)
 *
 * @param scheduleFn The scheduler used to create the rule factory you wish to
 * run pending rules for.  If not given, the default {@link rule}() factory is
 * targeted.
 *
 * @category Signals
 */
export function runRules(scheduleFn?: (cb: () => unknown) => unknown) {
    (scheduleFn ? ruleQueue(scheduleFn) : defaultQ).flush();
}
