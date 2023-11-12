# uneventful: signals plus streams, minus the seams

Reactive signals (like preact-signals) and streams (like rxjs) are both great ways of simplifying event-driven programming.  But each has different strengths, and making one do the work of the other is hard.  (And neither is that great at *sequential* asynchrony, the way CSP or goroutines are).

Enter `uneventful`: a seamless blend of signals, streams, and CSP-like, cancelable asynchronous jobs with automatic resource management.  If a task subscribes to a stream or creates an `effect()`, it's automatically cleaned up when the task ends -- or it or any parent task is canceled.  Likewise, if an effect spawns a task based on the value of a signal, the task is automatically canceled when the effect is rerun (or canceled by the end of an enclosing task).

The approach lets you use only the very *best* parts of all three paradigms, without needing to force something signal-like to be more streamy or vice versa, or to make either do something that's better represented as sequential steps.  Consider this contrived and somewhat silly example:

```typescript
import {effect, when, until, job, signal, fromDomEvent, interval } from "uneventful";

const buttonClick = fromDomEvent(buttonElement, "click");
const multiplierSignal = signal(1);

effect(() => {
    const multiplier = multiplierSignal.value;
    when(buttonClick, () => job(function*() {
        for (let i=1; i<=10; i++) {
            yield *until(interval(1000));
            outputElement.textContent = `${i*multiplier}...`;
        }
    }));
});
```
Whenever `buttonElement` is clicked, this code will place a series of values in `outputElement`, based on the current value of `multiplierSignal`.  if the button is clicked again while that's happening, the previous job will be aborted, and the series will start over.  If the value of `multiplierSignal` changes, the event handler will be re-registered and any outstanding series canceled.

Of course, if we *didn't* want the job to be canceled when the multiplier changes, we would've just referenced `multiplierSignal` in the `job()` function directly, and not in the `effect()`. And if we didn't want clicks to cancel the job either, we'd ditch the `when()` block and write the job with an outer loop that would `yield *until(buttonClick)` before running the inner loop, so it wouldn't be paying attention to clicks during the sequence.)

Notice how, if we could *only* use signals or streams or CSP, this example (and most of its possible variations) would be a good bit more **complex**.  To make it work with just streams, we'd need a lot of `switchMap` operators and callbacks.  With only signals, we'd have to unravel the job part into a state machine.  With just CSP, we'd need to turn the muliplier value into a channel and have a second job.

And *all* of them would be more code, more complexity, more glue to set things up and shut them down, and more potential for errors.

In contrast, uneventful's seamless blending of different kinds of reactivity with automatic cancel and cleanup means uneventful can be *lightweight*, both conceptually and in code size.  (You don't need to learn or use a hundred different stream operators, for example, when so many of them are things that can be expressed more cleanly as signal effects or sequential tasks.)

## API Overview

Just four simple functions provide nearly all of the reactive control flow you need, without any of the manual glue and cleanup you don't want to write:

- `effect()` performs actions based on one or more signal values, with automatic cleanup when the values change or the effect itself is canceled.
- `when()` consumes streams, promises, or truthy signal values, and runs a listener on the each value (with automatic cleanup of anything that listener used, when the listener is canceled, the stream closes or the next value/event arrives)
- `job()` creates an asynchronous job from a generator function - and will cancel it if the calling job, effect, or event listener is canceled
- `yield *until()` suspends a job to wait for a promise, event stream, or truthy signal value.  (And it automatically stops waiting and releases event listeners if the job is canceled.)

Under the hood, these APIs all use *disposal bins*: a collection of callbacks that are run when an activity is canceled, to release resources, listeners, or do other cleanup operations.  Bins can also be created inside of other bins, so that child activities' bins are cleaned up if the parent activities are canceled.  All four of the primary APIs work by creating such nested bins within the currently-active bin.

Of course, this means that there has to *be* a currently-active bin when you use these functions.  Jobs create their own bin and have it active while they're running, so `job()` and `yield *until()` are both covered already, as are `when()` and `effect()` when run inside another job, when, or effect.

But if you're creating an`effect()` or `when()` *outside* of any existing job, when, or effect, you'll need to handle its cleanup yourself.  You can use `bin.create()` to aggregate several `effect()` or `when()` calls into a single cleanup function, or call  `effect.root()` or `when.root()` to get individual disposal callbacks for each one.

## Current Status

This library is currently under development, but the ideas and most of the implementation are already working well as a draft version inside [@ophidian/core](https://github.com/ophidian-lib/core), for creating complex interactive Obsidian plugins.  The draft version is based on preact-signals for its signals implementation and wonka for its streams, but both will be replaced with uneventful-native implementations in this library, to drop the extra wrapping code, streamline some features, and add others.  (For example, preact-signals doesn't support nested effects and wonka doesn't support stream errors; uneventful will support both.)

