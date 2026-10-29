---
title: Changelog
---
# Changelog

### 0.0.17 (2026-10-28)

This is effectively a major release, with significant refactoring, deprecations, and behavior changes - please read carefully!

Most notably, the `Job<T>` type has been deprecated, having been split into three major sub-interfaces:

- `Task<T>` - a cancellable future value (returned from `start()`)
- `Work<T>` - the context in which a task runs, with cleanup facilities, async throw/catch, and the return/throw methods to complete the task.  (Passed into functions given to `start()`)
- `Checkpoint` - the kind of resettable context used by reactive effects and `restarting()` functions.

This makes separation of abilities and roles clearer, while reducing the mutable surface available to consumers by default.  The monolithic `Job` interface allowed anyone holding it to change things like its async error routing, run other tasks inside of it, or even manually `.return()` a value from it

Now, things like those are only possible from *inside* the task or via its `Work` handle.  (And if you want a Deferred-like way to configure a task from its outside, you can use the new `starting()` API to create a `Work` first and then get its `.task()` or `.future()` for consumers to use.)

As part of the changes, the zero-argument and two-argument versions of `start()` and `.start()` have also been deprecated, leaving only the single-argument forms.  The zero-argument form can be replaced by `starting().task()`, and the two-argument form with `start(boundTo(thisArg, fn))`.  (See {@link uneventful/utils.boundTo boundTo}() for more details.)

Many other types and APIs have also been renamed or replaced, with the old ones deprecated, notably:

| Before             | After                              |
|--------------------|------------------------------------|
| `getJob()`         | `currentContext()` |
| `isJobActive()`    | `inContext()` |
| `StartFn<T, This>` | `ActivityFn<T, This>` |
| `StartObj<T>`      | `Eventual<T>` |
| `AsyncStart<T>`    | `EventuallyReturns<T>` |
| `SyncStart<T>`     | `Setup<T>` |
| `Yielding<T>`      | `Yieldable<T>` |
| `JobIterator<T>`   | `Coroutine<T>` |
| `timeout(ms, ctx)` | `timeoutAfter(ms)` OR `watchdog()` |

There are also some new APIs, like:

- `starting()` (which is also a context method) lets you start multiple activities in the same context as a race or as parallels, and returns the `Work` rather than the task, so you can do further customization of the task
- `Work.exec()` lets you adopt `Eventual<T>` values or run additional `EventuallyReturns<T>` functions (such as `Coroutine<T>`-returning generator functions) within the same task.
- `timeoutAfter(ms)` takes advantage of `starting()` such that you can do e.g. `starting(someActivityOrEventualValue, timeoutAfter(2000)).task()` to get a cancellable task that aborts with `TimeoutError` if it doesn't finish in 2s.
- `watchdog()` lets you create a resettable deadline timer that async-throws `TimeoutError` in its creation context if it ever expires without being reset or disabled.

Last, but not least, bare `start()` with no arguments still returns a `Job`, but is now deprecated for the same reason `Job` is.  Most such uses should be replaced with `starting()` (which returns a `Work` context), and perhaps a conversion to `.task()` afterward.

Various other fixes, enhancements and behavior changes are listed below by module:

`uneventful`
- `newRoot()` now carries over the `.asyncCatch()` handler from the previous root and only uses the default for the first root, or if the previous root's handler was explicitly unset.

- Fixed: Coroutines that suspend in `finally` clauses and were canceled could leak `using` disposals and also and never finish.  Now, when a coroutine is canceled, all suspends in `finally` clauses are forced to jump to the next-outer finally block, skipping the rest of the suspended `finally` block.

- **Backward-incompatible Behavior and Typing changes**:
  - `start(something)` now defaults to `Task<never>` as the return type (and `Work<never>` as the argument type) if TypeScript cannot otherwise infer the type.  This may result in some type errors requiring you to explicitly specify the type, e.g. via `start<TheType>(something)`, though runtime behavior should be unaffected.  This change ensures that `.return()` values are typechecked by default and require you to explicitly declare a type in cases of ambiguity.  (The previous default was `unknown`.)
  - Waiting on an unfinished task with `yield*` now resumes in a *different microtask* than the one where the task ended.  (Though waiting on an already-finished task still resumes synchronously.)  This change was made to avoid waiters seeing partially-undone state and running arbitrary code during a task's end.  Now cleanup for an ending task is atomic from the point of view of its asynchronous waiters, whether they use `yield*` or `await`.
  - If you use return() or throw() or otherwise cancel a `start()`ed generator/genfunc before it has a chance to start running (i.e., while still in the same microtask as the `start()` call), then the generator will *not* be started.  The previous behavior caused an unnecessary thrash, where the generator would run until the first yield, performing actions that would then be immediately rolled back.
  - Canceling a coroutine with a `finally` clause now executes that clause *after* all child tasks have been fully canceled and all their cleanups run.  Previously, the finally clause ran at an earlier stage where cleanups might not have run yet.  The new behavior is more consistent with how structured concurrency is handled everywhere else, but may cause issues if you have `finally` clauses that expected to interact with resources that will now be cleaned up in such a case.

`uneventful/shared`
- There is now a new, experimental {@link uneventful/shared.target `target()`} API.  Targets are similar to `make` or systemd targets in that they are built or launched on demand, run asynchronously, and may be used to represent a feature flag, group of sub-targets, or some other abstraction.  They are also like an asynchronous version of a {@link uneventful/shared.service `service()`}, in that they're lazily-initialized, run once per given root (and reset with `newRoot()`), and can have their implementation overridden for configuration or testing purposes.

`uneventful/signals`
- The `runRules()` API now explicitly flushes demand changes (subscribing/unsubscribing jobs and external data sources) even if there are no rules on the selected queue, thus ensuring that if anything *would* be updated on that queue, it will happen before `runRules()` returns.
- In addition, `runRules()` will now throw an error if run inside a rule, to make visible the fact that it is impossible to flush a queue while another queue (or the same queue!) is being flushed.  (Previously, this simply silently failed with no effect, running the rules asynchronously at the next scheduled opportunity.)

`uneventful/utils`
- There is now a {@link uneventful/utils.boundTo boundTo}() function that is a better-typed, prefix syntax alternative to `Function.prototype.bind`.

### 0.0.16 (2026-09-10)

`uneventful/shared`

The experimental `$cache` API has been dropped, replaced with configurable service accessors.  So `$` now returns "lazy constants" from both of its overloads, with `$()` returning a global constant instead of a configurable singleton.  (Per-signal scoped constants are unchanged, but have some added execution restrictions.)

Both {@link uneventful/shared.$ `$`} overloads also been upgraded out of experimental status, with the following improvements/changes:

- `$` now forces *all* factories to run without access to reactive values, to avoid erroneously capturing stale context.
- Lazy constants are initialized with *no* active job, since they can't have meaningful side-effects requiring cleanup.

{@link uneventful/shared.service `service()`} can now use classes as factories, and you can mock/replace/override their service implementations, among other improvements:

- Service factories are now run in the root job, and the services are automatically disposed of when a new root job is started by ``newRoot()``.

Dependency cycles in a `$()` or service factory are now stopped early with a thrown error, *without* needing to overflow the runtime stack.

### 0.0.15 (2026-09-08)

Note: this release was deprecated/unpublished due to some significant regressions/misfeatures in its design.  Please skip to 0.0.16 or higher.

### 0.0.14 (2026-02-26)

`uneventful/signals`
- Fix: `fx()` should *immediately* recalculate when they transition to being in-demand, as their side-effects can't be cached.


### 0.0.13 (2026-02-09)

`uneventful`
- Removed the deprecated `detached` and `rule.detached` APIs
- `isJobActive()` will now return true when invoked in a signal function that hasn't used any job functions, so long as the signal `isObserved()`.
- The `makeJob()` function is now deprecated; please see its docs for migration instructions.

`uneventful/signals`
- BREAKING: If a signal is unobserved (e.g. due to `peek()` or not being observed by a rule), using the jobs API in it will now throw an error, instead of silently rolling everything back that it just did.  This prevents bugs and inefficiencies caused by silent thrashing, at the cost of this compatibility break.  If you want the signal to be usable even when unobserved, you can use `isObserved()` to avoid using job APIs when the signal is unobserved, or move the job-related actions to an {@link uneventful/signals.fx `fx()`} (as effects do not run unless they are observed).
- Added the {@link uneventful/signals.fn `fn()`} and {@link uneventful/signals.fx `fx()`} functions as the easiest way to create computed signals and effects, respectively.  Both allow creating simple signals/effects, method decorators, functions that create and apply signals/effects on the fly as extensions of arbitrary objects, and inline-cached, per-signal, per-location variants.  `fx()` are rule-like in that they can be called from any job and trigger observation of anything they depend on, but unlike rules they are started synchronously and can be shared by multiple jobs and even called/observed by other signals, providing idempotent actions and side-effects.
- Signals that gain their first (or lose their last) observer now run their setup or cleanup as part of the active rule batch (if applicable), instead of waiting for the next microtask.  This makes side effects (such as DOM manipulation) happen closer to the time when the rules controlling them are run (at the cost of possible thrashing if a sole controlling rule is terminated and replaced with one on a different scheduler).

`uneventful/shared`
- Added the experimental {@link uneventful/shared.$ "singleton" operator, `$`}, which can be used as both a nano-dependency injector, and a useMemo-like utility for signal functions.

`uneventful/utils`
- Added {@link uneventful/utils.isClass `isClass()`} and {@link uneventful/utils.isPlainObject `isPlainObject()`}

### 0.0.12 (2025-04-07)

`uneventful/ext`
- {@link uneventful/ext.Ext `Ext`}: refactored how instance construction works to eliminate some typing pitfalls and simplify overriding `__new__`

`uneventful/signals`
- Replaced `unchangedIf()` with {@link uneventful/signals.stable `stable()`}, {@link uneventful/signals.stableArray `stableArray()`} and other {@link uneventful/signals.stabilizer `stablilizer()`} features.  (The old function has been deprecated and will be removed in a later release.)

### 0.0.11 (2025-04-06)

`uneventful`
- Refactored internal context management to use less memory (and fewer objects) per signal, and to reduce the amount of pointer indirection on some common code paths.

`uneventful/ext` (NEW)
- New module for easily adding on-the-fly extension properties and methods to arbitrary objects, inspired by the [Python AddOns package](https://pypi.org/project/AddOns/).

`uneventful/signals`
- Fixed an issue where signals polling external data using {@link uneventful.recalcWhen}() could become stale unless observed by a rule.
- Reduced thrashing behavior of signals w/no deps that are executed purely for job side-effects. Previously, they would rollback and re-run every time they were called, but now they only roll back if they cease being observed.  (And if called when unobserved, they will only start+rollback the first time they end up with no dependencies.)  In terms of end results, the behavior is still the same: i.e., the signal job will end up active or rolled back during the same general periods, this just gets rid of temporary flip-flopping when the signal doesn't depend on any other signals.

`uneventful/utils`
- Added {@link uneventful/utils.call `call()`} function as an IIFE replacement utility

### 0.0.10 (2025-01-11)

`uneventful`
  - Added `root` job to replace `detached` (which is now deprecated).  Creating root-based rather than detached jobs means there is a single point from which all resources can be cleaned up.

`uneventful/shared` (NEW)
  - {@link uneventful/shared.service `service()`}: wrap a factory function to create a singleton service accessor
  - {@link uneventful/shared.fork `fork()`}: wrap a generator, generator function, or generator method to run in parallel, and have a result that can be waited on in parallel as well
  - {@link uneventful/shared.expiring `expiring()`}: proxy an object so it cannot be accessed after the calling job ends

`uneventful/signals`
  - Added {@link uneventful/signals.rule.root `rule.root`} to replace `rule.detached` (which is now deprecated)
  - Added `.edit()` method to writable signals (to patch the existing value using a function)
  - Fixed code inside a {@link uneventful/signals.peek `peek()`} or {@link uneventful/signals.action `action()`} not being able to access the job of the enclosing rule, if it hadn't already been used

`uneventful/utils`
  - Added {@link uneventful/utils.decorateMethod `decorateMethod()`}: a helper for creating hybrid (TC39/legacy) decorator/function wrappers
  - Added {@link uneventful/utils.isGeneratorFunction `isGeneratorFunction()`} to check for native generator function

### 0.0.9 (2024-11-17)

- Fixed: `task` decorator was passing the job as an extra argument to the wrapped function

### 0.0.8 (2024-11-17)

`uneventful/signals`
- Any computed signal (i.e. a `cached()` function or a `value()` with a `.setf()`) can now start jobs or register cleanups for their side-effects.  (Previously, only rules could do this.)

  The jobs are ended (or cleanups run) when the signal ceases to have subscribers, or when the values the signal depends on change. (Unobserved signals with jobs are also recalculated if they gain subscribers later, even if none of their dependencies have changed.  This is so their side-effects will be restored without needing to wait for a change in their dependencies.)

  You can also use the new `isObserved()` function (from the `uneventful` main package) to test whether the current code is running inside of an observed signal or rule, with the side-effect that if the signal is *not* currently observed, then it will be recalculated when it *becomes* observed.  (This lets you avoid setting up jobs or cleanup-needing effects that will be immediately discarded due to a lack of subscribers, but still set them up as soon as there is demand for them.)

- Added `unchangedIf()`: allows reactive expressions (in `cached()` or `value().setf()`) to return their previous value if the new value is equivalent according to a custom comparison function (`arrayEq()` by default)
- **Backward incompatibility**: Removed the `stop` parameter from rule functions, so that signals and zero-argument states can be used as rule actions.  (Use `rule.stop()` instead.)

`uneventful/utils`
  - Expose `batch()` factory for creating generic batch processors
  - Add `GeneratorBase` for identifying generators with `instanceof`
  - Add `arrayEq()` for comparing array contents
- Refactor scheduling internals to remove subclassing

### 0.0.7 (2024-07-16)

- Fix build process not running tests

### 0.0.6 (2024-07-14)

- Moved main signals API to a separate export (`uneventful/signals`) and exposed the utils module as an export (`uneventful/utils`).
- Expanded and enhanced the `RuleFactory` interface:
  - `rule.stop` can now be saved and then called from outside a rule
  - `rule.detached(...)` is a new shorthand for `detached.run(rule, ...)`
  - `rule.setScheduler()` lets you change how a rule will be scheduled (from inside it)
- Changed when streams-as-signals and `recalcWhen()` handle subscribes and unsubscribes so that they don't thrash on and off when there's a single subscriber that's synchronously removed and re-added.

### 0.0.5 (2024-05-26)

- Fix: `next()` and `until()` should not resume job with the rule still active
- Fix: signal unsubscription causing future conditional re-subscriptions to fail

### 0.0.4 (2024-05-21)

- Added "constant folding" to signals: a cached function that has no dependencies (statically or dynamically) will become a constant and in turn omitted from the dependencies of its readers, which will then also become constants if they have no other dependencies.
- Track "virtual reads" of signals for write conflict and cycle detection.  (A signal is "virtually" read if its value is known to be unchanged, and that fact is relied upon to *avoid* recalculating other values.  Such "virtual" reads must still be considered a write conflict if written to during the same timestamp.)
- `noDeps()` has been renamed `peek()`
- `Signal` and `Writable` are now interfaces instead of classes
- The rules API has been overhauled:
    - Added the `rule.if()` API
    - Added the `@rule.method` decorator (with TC39/legacy decorator autodetection)
    - `rule.factory()` replaces `RuleScheduler.for()`
    - `rule.stop()` stops the active rule
    - `runRules()` can be given a scheduling function to flush a specific queue
- The `until()` API has now been split: `next()` is used to get a signal or stream's next value, while `until()` yields the next *truthy* value, and auto-converts zero-argument functions to signals.  `until()` also does not work on promises any more, since `start()`, `to()` and `fromPromise()` all accept promises already.
- New wrapper/decorators: `task(fn)`/`@task`,  and `action(fn)`/`@action`.  Both support both the TC39 and legacy decorator protocols.
- The type previously called `Source` is now `Stream`, and the type previously called `Producer` is now `Source`.  This helps make the documentation clearer on some points.
- `value()` objects now have a `.setf()` method that can be used to set them to a "formula" (callback expression), not unlike a spreadsheet cell.  Regular `.set()` overwrites the formula with a value, and `.setf()` replaces the value with a formula.  This makes it easier to implement components with configurable signal bindings.
- Fix `lazy()` stream not forwarding its inlet
- Fix misc. issues with the ending of streams implemented as signals

### 0.0.3 (2024-05-13)

- Dropped CJS export
- Allow returning a cleanup callback from a `start()` callback
- Added `forEach()` API
- Improved Source and Signal type inference

### 0.0.2 (2024-05-05)

- Fix: signals used as streams should run sinks in a null context to prevent dependency tracking
- Fix: signals' `until()` rules should be ended when the job resumes

### 0.0.1 (2024-05-04)

- Initial release
