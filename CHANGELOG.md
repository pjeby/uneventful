# Changelog

### 0.0.6 (unreleased)

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

