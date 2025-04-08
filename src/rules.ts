import { defer } from "./defer.ts";
import { Cell, RuleQueue, currentRule, defaultQ, ruleQueue } from "./cells.ts";
import { AnyFunction, DisposeFn, OptionalCleanup } from "./types.ts";
import { CallableObject, apply, setMap } from "./utils.ts";
import { detached, root } from "./tracking.ts";

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
    (fn: () => OptionalCleanup): DisposeFn;

    /**
     * A function that will stop the currently-executing rule.  (Accessing this
     * attribute will throw an error if no rule is currently running.)
     *
     * Note: this returns the stop for the current rule regardless of its
     * scheduler, so you can access `rule.stop` even if the rule was created
     * with a different scheduler.
     */
    readonly stop: DisposeFn;

    /**
     * Observe a condition and apply an action.
     *
     * For a given {@link RuleFactory} `r` (such as `rule`), `r.if(condition,
     * action)` is roughly equivalent to `r(() => { if (condition()) return
     * action(); })`, except that the rule is *only* rerun if the `action`'s
     * dependencies change, *or* the **truthiness** of `condition()` changes. It
     * will *not* be re-run if only the dependencies of `condition()` have
     * changed, without affecting its truthiness.
     *
     * This behavior can be important for rules that nest other rules, have
     * cleanups, fire off tasks, etc., as it may be wasteful to constantly tear
     * them down and set them back up if the enabling condition is a calculation
     * with frequently-changing dependencies.
     *
     * @remarks This is just a shortcut for wrapping `condition` as a signal
     * that converts it to boolean. So if you already *have* a boolean signal,
     * you can get the same effect with just `if (condition()) { ... }`.
     */
    if(condition: () => any, action: () => OptionalCleanup): DisposeFn

    /**
     * Decorate a method or function to behave as a rule, e.g.
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
     * or:
     * ```ts
     * const logger = rule.method((formatString, signal) => { log(formatString, signal()); });
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
    factory(scheduleFn: SchedulerFn): RuleFactory

    /**
     * @deprecated Use {@link RuleFactory.root} instead
     *
     * ---
     * Create a "detached" or standalone rule, that is not attached to any job.
     *
     * `r.detached(fn)` is shorthand for calling `detached.run(r, fn)`.  (Where
     * `r` is a {@link RuleFactory} such as `rule`.)
     *
     * Note that since the created rule isn't attached to a job, it *must* be
     * explicitly stopped, either by calling the returned disposal function or
     * by the rule function arranging to stop itself via {@link rule.stop}().
     */
    detached(fn: () => OptionalCleanup): DisposeFn;

    /**
     * Create a standalone rule, not attached to the current job.
     *
     * `r.root(fn)` is shorthand for calling `root.run(r, fn)`, where `r` is a
     * {@link RuleFactory} such as `rule`.
     *
     * The created rule will run until the {@link root} job stops, unless
     * explicitly stopped.  (Either by calling the returned disposal function or
     * by the rule function arranging to stop itself via {@link rule.stop}().)
     */
    root(fn: () => OptionalCleanup): DisposeFn;

    /**
     * Change the scheduler used for the currently-executing rule.  Throws an
     * error if no rule is running.
     *
     * @param scheduleFn Optional: The {@link SchedulerFn scheduling function}
     * to use; the default microtask scheduler will be used if none is given or
     * the given value is falsy.
     *
     * @remarks It's best to only use scheduling functions that were created
     * *outside* the current rule, otherwise you'll be creating a new scheduling
     * queue object on every run of the rule.  (These will get garbage collected
     * with the scheduling functions, but you'll be creating more memory
     * pressure and using more GC time if the rule runs frequently.)
     */
    setScheduler(scheduleFn?: SchedulerFn): void;
}

type RuleFunction = (fn: ActionFunction) => DisposeFn
type ActionFunction = () => OptionalCleanup

class RF extends CallableObject<RuleFunction> implements RuleFactory {

    constructor(q: RuleQueue) {
        super((fn: ActionFunction) => Cell.mkRule(fn, q))
    }

    get stop() {
        if (currentRule) return currentRule.stop.bind(currentRule);
        throw new Error("No rule active");
    }

    if(condition: () => any, action: () => OptionalCleanup): DisposeFn {
        const cond = Cell.mkCached(() => !!condition());
        return this(() => cond.getValue() ? action() : undefined);
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
                return self(() => apply(fn as any, this, args));
            };
        }
    }

    factory(scheduleFn: SchedulerFn): RuleFactory {
        return factories.get(scheduleFn) || setMap(factories, scheduleFn, new RF(ruleQueue(scheduleFn)));
    }

    detached(fn: ActionFunction) {
        return detached.run(this as RuleFunction, fn);
    }

    root(fn: ActionFunction) {
        return root.run(this as RuleFunction, fn);
    }

    setScheduler(scheduleFn?: SchedulerFn): void {
        if (currentRule) currentRule.setQ(scheduleFn ? ruleQueue(scheduleFn) : defaultQ);
        else throw new Error("No rule active");
    }
}


const factories = new WeakMap<Function, RuleFactory>();

/**
 * Subscribe a function to run every time certain values change.
 *
 * The function is run asynchronously, first after being created, then again
 * after there are changes in any of the {@link value}()s or {@link cached}()
 * functions it read during its previous run.
 *
 * The created subscription is tied to the currently-active job (which may be
 * another rule).  So when that job is ended or restarted, the rule will be
 * terminated automatically.  You can also terminate it early by calling the
 * "stop" function that is returned by `rule()`, or by calling
 * {@link rule.stop}() from within the rule function.
 *
 * Note: this function will throw an error if called without an active job. If
 * you need a standalone rule, use {@link RuleFactory.root rule.root}().
 *
 * @param fn The function that will be run each time its dependencies change.
 * The function will be run in a restarted job each time, with any resources
 * used by the previous run being cleaned up.  The function is called with no
 * arguments, and should return a cleanup function or void.
 *
 * @returns A function that can be called to terminate the rule.
 *
 * @category none
 * @function
 */
export const rule: ((fn: () => OptionalCleanup) => DisposeFn) & RuleFactory = (
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
 * @param scheduleFn The {@link SchedulerFn scheduler} used to create the rule
 * factory you wish to run pending rules for.  If not given, the default
 * {@link rule}() factory is targeted.
 *
 * @category Scheduling
 */
export function runRules(scheduleFn?: SchedulerFn) {
    (scheduleFn ? ruleQueue(scheduleFn) : defaultQ).flush();
}

/**
 * A single-argument scheduling function (such as requestAnimationFrame,
 * setImmediate, or queueMicrotask).  The rule scheduler will call it from time
 * to time with a single callback.  The scheduling function should then arrange
 * for that callback to be invoked *once* at some future point, when it is the
 * desired time for all pending rules on that scheduler to run.
 *
 * @category Types and Interfaces
 */
export type SchedulerFn = (cb: () => unknown) => unknown;
