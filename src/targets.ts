import { isError, noop } from "./results.ts"
import { root, rootId, newRoot } from "./tracking.ts"
import { Activity, ActivityFn, EventuallyReturns, Future, Setup, Work, Yieldable } from "./types.ts"

/**
 * Define a shared, configurable unit of work that's run on-demand, at most once
 *
 * A {@link Target} is like a {@link service}(), in that it's defined once,
 * started on demand, and can be reused across calls to {@link newRoot}().
 *
 * But instead of being synchronously built when called, targets are
 * *asynchronously* started on *use*: either by calling them directly or calling
 * any of their methods (other than .{@link Target.used used}()).
 *
 * @param recipe An optional {@link ActivityFn} that will be started in a task
 * when the target is first used.  Its eventual return value or thrown error
 * will commit the target and be passed on to the target's observer(s).
 *
 * (Important: when the recipe returns or throws, *its task will be ended*!  Any
 * processes, effects, etc. that need to last beyond the target's completion
 * should be done by having the recipe start {@link service}()s or other
 * separate, *non-child* tasks.)
 *
 * A target's recipe can be overridden using the .{@link Target.start start}(),
 * .{@link Target.complete complete}() or .{@link Target.fail fail}() methods,
 * so long as the target hasn't been started yet.  (Similar to the way services'
 * implementations can be overridden via their `.set()` and `.replace()`
 * methods, but with slightly different mechanics since targets are started
 * asynchronously.)
 *
 * Note that if no recipe is given when the target is created, it **must** be
 * explicitly started, completed or failed.  Otherwise, its observers will wait
 * *forever*, as the target will never be started or committed.  (So most
 * targets should have a recipe, unless you're using it as a semaphore or a
 * coordination point between other targets.)
 *
 * @category Resources
 * @experimental
 */
export function target<T=void>(recipe?: EventuallyReturns<T>): Target<T> {
    type State = {work: Work<T>, rootId: number, started: boolean}
    let state: State

    const tgt: Target<T> = Object.assign(
        () => requestedWork(recipe).future(), {
            used:     ()  => state?.rootId === rootId,  // state created in current root?
            start:    activity => startedWork(activity).future(),
            complete: val => { startedWork().return(val!) },
            fail:     why => { startedWork(w => w.task().onError(noop)).throw(new Error(why)) },
        } as Target<T>
    )
    return tgt

    function requestedWork(activity?: Activity<T>) {
        return (tgt.used() ? state : state = {
            work: activity ? root.starting(activity) : root.starting(),
            rootId,
            started: !!activity
        }).work
    }
    function startedWork(activity?: Activity<T>) {
        if (tgt.used()) {
            const r = state.work.future().result()
            if (isError(r)) throw r.err
            if (r) throw new Error("Target already finished")
            if (state.started) throw new Error("Target already started")
            if (activity) {
                state.work.exec(activity)
                state.started = true
            }
            return state.work
        }
        return requestedWork(activity)
    }
}

/**
 * An object representing a desired outcome, such as a task performed, a
 * condition reached, or a value produced.
 *
 * As in tools like `make` and systemd, targets are things run or produced once,
 * lazily, on-demand.  Targets track demand for their work, the state of that
 * work, and its ultimate result (success value or failure reason).
 *
 * Like services, targets have overridable implementations that can be
 * configured for testing or customization purposes.  They can also be forced
 * into a committed state with a specific value or error, either for testing or
 * for loosely-coupled coordination patterns.
 *
 * A target's lifecycle looks roughly like this: unused -> requested -> started
 * -> committed (i.e. completed or failed):
 *
 * - Unused: freshly-created {@link target}()s are unused, and they return to
 *   being unused after a {@link newRoot}() call.  (Making them resettable for
 *   testing.)
 *
 * - Requested: a target becomes requested as soon as it is [called](#target) to
 *   access its {@link Future} result.  If the target has a recipe, that recipe
 *   is started immediately, and the target proceeds to the Started state.
 *
 * - Started: Once started, a target's recipe runs to completion or failure,
 *   determining its committed state.  A started target's recipe is locked in
 *   and can't be overridden using its {@link Target.start `.start()`},
 *   {@link fail `.fail()`}, or {@link complete `.complete()`} methods: they can
 *   only be used in the "unused" or "requested" states.
 *
 * - Committed: when a recipe completes or fails, or the target is manually
 *   `.complete()`d or `.fail()`ed, it becomes *committed*: the result and any
 *   output value are available for querying, as well as being broadcast to any
 *   observers that were waiting for the target to complete.
 *
 * A rough state diagram:
 *
 * ```
 *         const tgt = target(recipe?)
 *                    │
 *                    ▼
 *               ┌──────────┐
 * ┌<────────────│  UNUSED  │─────────────>┐
 * │             └──────────┘              │
 * │                  │                    │
 * │                tgt()                  │
 * │                  │                    │
 * │                  ▼                    │
 * │             ┌───────────┐             │
 * ├<────────────│ REQUESTED │────────────>┤
 * │             └───────────┘             │
 * │                  │                    │
 * │        automatic transition if        │
 * │            created w/recipe           │
 * │                  │                    │
 * │                  ▼           .complete(output) or
 * │  .start()   ┌──────────┐         .fail(reason)
 * └────────────>│ STARTED  │              │
 *               └──────────┘              │
 *                    │                    │
 *          recipe returns / throws        │
 *                    │                    │
 *                    │<───────────────────┘
 *                    │
 *                    ▼
 * ┌─────────────────────────────────────────┐
 * │              COMMITTED                  │
 * │   completed w/value or failed w/error   │
 * └─────────────────────────────────────────┘
 * further .start()/.complete()/.fail() → throw
 *       newRoot() resets back to unused
 * ```
 *
 * @template T The type of output value the target produces, if any: defaults to
 * `void` if not specified.
 *
 * @category Types and Interfaces
 * @experimental
 */
export interface Target<T=void> {
    /**
     * Request the target's outcome as an async future
     *
     * If the target is unused, it will transition to "requested" status, and
     * then "started" if it was created with a recipe.
     *
     * @returns a {@link Future} implementing the Promise and {@link Yieldable}
     * interfaces for the target's result.  You can wait for it using
     * `await`, `yield *`, `Promise.all()`, or the synchronous `.do()`,
     * `.onValue()`, etc. methods.
     */
    (): Future<T>

    /**
     * Start work on the target using a new or changed recipe
     *
     * This works like .{@link complete}(), except that it lets you pass a
     * generator, promise, generator function, task, target, {@link Setup}
     * function, etc. to complete the target *asynchronously*.  The target's
     * previous recipe, if any, will be ignored.
     *
     * This method puts the target into the "started" state, and will throw an
     * error if invoked on a target that's already started or committed.
     *
     * @returns The target's Future
     */
    start(recipe: Activity<T>): Future<T>

    /**
     * Declare the target completed, committing it without using a recipe
     *
     * The existing recipe, if any, will not be run.
     *
     * This method can only be called on an unstarted target, or an error will
     * be thrown.
     *
     * @param value The output value to pass on to observers (can be omitted if
     * the {@link T} type is void/undefined)
     */
    complete(value: T): void

    /** @hidden extra overload for omitting the value when {@link T} is undefined */
    complete(...val: T extends undefined ? [] : [T]): void

    /**
     * Commit the target as failed, with a reason
     *
     * Subsequent attempts to .{@link complete}() or fail the target will throw
     * with the given error message.
     *
     * As with `.complete()` and `.start()`, this can only be run on an
     * unstarted target, and overrides any existing recipe.
     */
    fail(reason: string): void

    /**
     * Has the target, or any of its methods, been called yet?
     *
     * (Note: this is the *only* Target method that doesn't move the target out
     * of the "unused" state.)
     */
    used(): boolean
}
