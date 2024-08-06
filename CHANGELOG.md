# Changelog

### 0.0.8 (Unreleased)

- Any computed signal (i.e. a `cached()` function or a `value()` with a `.setf()`) can now start jobs or register cleanups for their side-effects.  (Previously, only rules could do this.)

  The jobs are ended (or cleanups run) when the signal ceases to have subscribers, or when the values the signal depends on change. (Unobserved signals with jobs are also recalculated if they gain subscribers later, even if none of their dependencies have changed.  This is so their side-effects will be restored without needing to wait for a change in their dependencies.)

  You can also use the new `isObserved()` function to test whether the current code is running inside of an observed signal or rule, with the side-effect that if the signal is *not* currently observed, then it will be recalculated when it *becomes* observed.  (This lets you avoid setting up jobs or cleanup-needing effects that will be immediately discarded due to a lack of subscribers, but still set them up as soon as there is demand for them.)

- `uneventful/signals`:
  - Added `unchangedIf()`: allows reactive expressions (in `cached()` or `value().setf()`) to return their previous value if the new value is equivalent according to a custom comparison function (`arrayEq()` by default)
- `uneventful/utils`:
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

