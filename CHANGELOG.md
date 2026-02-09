---
title: Changelog
---
# Changelog

### 0.0.13 (2026-02-09)

`uneventful`
- Removed the deprecated `detached` and `rule.detached` APIs
- `isJobActive()` will now return true when invoked in a signal function that hasn't used any job functions, so long as the signal `isObserved()`.
- The {@link uneventful.makeJob `makeJob()`} function is now deprecated; please see its docs for migration instructions.

`uneventful/signals`
- BREAKING: If a signal is unobserved (e.g. due to `peek()` or not being observed by a rule), using the jobs API in it will now throw an error, instead of silently rolling everything back that it just did.  This prevents bugs and inefficiencies caused by silent thrashing, at the cost of this compatibility break.  If you want the signal to be usable even when unobserved, you can use `isObserved()` to avoid using job APIs when the signal is unobserved, or move the job-related actions to an {@link uneventful/signals.fx `fx()`} (as effects do not run unless they are observed).
- Added the {@link uneventful/signals.fn `fn()`} and {@link uneventful/signals.fx `fx()`} functions as the easiest way to create computed signals and effects, respectively.  Both allow creating simple signals/effects, method decorators, functions that create and apply signals/effects on the fly as extensions of arbitrary objects, and inline-cached, per-signal, per-location variants.  `fx()` are rule-like in that they can be called from any job and trigger observation of anything they depend on, but unlike rules they are started synchronously and can be shared by multiple jobs and even called/observed by other signals, providing idempotent actions and side-effects.
- Signals that gain their first (or lose their last) observer now run their setup or cleanup as part of the active rule batch (if applicable), instead of waiting for the next microtask.  This makes side effects (such as DOM manipulation) happen closer to the time when the rules controlling them are run (at the cost of possible thrashing if a sole controlling rule is terminated and replaced with one on a different scheduler).

`uneventful/shared`
- Added the experimental {@link uneventful/shared.$ "singleton" operator, `$`}, which can be used as both a nano-dependency injector, and a useMemo-like utility for signal functions.

`uneventful/utils`
- Added {@link uneventful/utils.isClass `isClass()`} and {@link uneventful/utils.isPlainObject `isPlainObject()`}

### 0.0.12

`uneventful/ext`
- {@link uneventful/ext.Ext `Ext`}: refactored how instance construction works to eliminate some typing pitfalls and simplify overriding `__new__`

`uneventful/signals`
- Replaced `unchangedIf()` with {@link uneventful/signals.stable `stable()`}, {@link uneventful/signals.stableArray `stableArray()`} and other {@link uneventful/signals.stabilizer `stablilizer()`} features.  (The old function has been deprecated and will be removed in a later release.)

### 0.0.11

`uneventful`
- Refactored internal context management to use less memory (and fewer objects) per signal, and to reduce the amount of pointer indirection on some common code paths.

`uneventful/ext` (NEW)
- New module for easily adding on-the-fly extension properties and methods to arbitrary objects, inspired by the [Python AddOns package](https://pypi.org/project/AddOns/).

`uneventful/signals`
- Fixed an issue where signals polling external data using {@link uneventful.recalcWhen}() could become stale unless observed by a rule.
- Reduced thrashing behavior of signals w/no deps that are executed purely for job side-effects. Previously, they would rollback and re-run every time they were called, but now they only roll back if they cease being observed.  (And if called when unobserved, they will only start+rollback the first time they end up with no dependencies.)  In terms of end results, the behavior is still the same: i.e., the signal job will end up active or rolled back during the same general periods, this just gets rid of temporary flip-flopping when the signal doesn't depend on any other signals.

`uneventful/utils`
- Added {@link uneventful/utils.call `call()`} function as an IIFE replacement utility

### 0.0.10

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

### 0.0.9

- Fixed: `task` decorator was passing the job as an extra argument to the wrapped function

### 0.0.8

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

### 0.0.7

- Fix build process not running tests

### 0.0.6

- Moved main signals API to a separate export (`uneventful/signals`) and exposed the utils module as an export (`uneventful/utils`).
- Expanded and enhanced the `RuleFactory` interface:
  - `rule.stop` can now be saved and then called from outside a rule
  - `rule.detached(...)` is a new shorthand for `detached.run(rule, ...)`
  - `rule.setScheduler()` lets you change how a rule will be scheduled (from inside it)
- Changed when streams-as-signals and `recalcWhen()` handle subscribes and unsubscribes so that they don't thrash on and off when there's a single subscriber that's synchronously removed and re-added.

### 0.0.5

- Fix: `next()` and `until()` should not resume job with the rule still active
- Fix: signal unsubscription causing future conditional re-subscriptions to fail

### 0.0.4

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

### 0.0.3

- Dropped CJS export
- Allow returning a cleanup callback from a `start()` callback
- Added `forEach()` API
- Improved Source and Signal type inference

### 0.0.2

- Fix: signals used as streams should run sinks in a null context to prevent dependency tracking
- Fix: signals' `until()` rules should be ended when the job resumes

### 0.0.1

- Initial release

