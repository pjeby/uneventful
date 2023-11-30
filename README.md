# uneventful: signals plus streams, minus the seams

Reactive signals (like preact-signals) and streams (like rxjs) are both great ways of simplifying event-driven programming.  But each has different strengths, and making one do the work of the other is hard.  (And neither is that great at *sequential* asynchrony, the way CSP or goroutines are).

Enter `uneventful`: a seamless blend of signals, streams, and CSP-like, cancelable asynchronous jobs with automatic resource management.  If a job subscribes to a stream or creates an `effect()`, it's automatically cleaned up when the job ends -- or it or any parent job is canceled.  Likewise, if an effect spawns a job based on the value of a signal, the job is automatically canceled when the effect is rerun (or canceled by the end of an enclosing job).

The approach lets you use only the very *best* parts of all three paradigms, without needing to force something signal-like to be more streamy or vice versa, or to make either do something that's better represented as sequential steps.  Consider this contrived and somewhat silly example:

```typescript
import { effect, when, until, job, value, fromDomEvent, interval } from "uneventful";

const buttonClick = fromDomEvent(buttonElement, "click");
const multiplierValue = value(1);

effect(() => {
    const multiplier = multiplierValue();
    when(buttonClick, () => job(function*() {
        for (let i=1; i<=10; i++) {
            yield *until(interval(1000));
            outputElement.textContent = `${i*multiplier}...`;
        }
    }));
});
```
Whenever `buttonElement` is clicked, this code will place a series of values in `outputElement`, based on the current value of the `multiplierValue` signal.  if the button is clicked again while that's happening, the previous job will be aborted, and the series will start over.  If the value of the `multiplierValue` signal changes, the event handler will be re-registered and any outstanding series canceled.

Of course, if we *didn't* want the job to be canceled when the multiplier changes, we would've just referenced `multiplierValue` in the `job()` function directly, and not in the `effect()`.  And if we didn't want clicks to cancel the job either, we could ditch the `when()` block and just write the job as an outer loop that does a`yield *until(buttonClick)` before running the inner loop, so it wouldn't be paying attention to clicks while counting.

Notice how, if we could *only* use signals or streams or CSP, this example (and most of its possible variations) would be a good bit more **complex**.  To make it work with just streams, we'd need a lot of `switchMap` operators and callbacks.  With only signals, we'd have to unravel the job part into a state machine.  With just CSP, we'd need to turn the muliplier value into a channel and have a second job.

And *all* of them would be more code, more complexity, more *glue* to set things up and shut them down, and more potential for errors.

In contrast, uneventful's seamless blending of different kinds of reactivity (with automatic canceling and resource cleanup) means uneventful can be *lightweight*, both conceptually and in code size.  You don't need to learn or use a hundred different stream operators, for example, when so many of them are things that can be expressed more cleanly as signal effects or sequential tasks.

## Features and Differences

### Flows

Uneventful's API revolves around its three fundamental kinds of "flows":

- `effect(`*side-effect function*`)` runs a function for each update to the values of one or more [signals](#signals), with automatic resource cleanup before each update and when the effect itself is canceled.
- `when(`*source*`, `*listener*`)` consumes streams, promises, or "truthy" signal values, running a listener once for each received value (with automatic cleanup of any resources the listener used when the flow is canceled, the stream closes or the next value/event arrives).
- `job(`*generator-or-genfunc*`)` creates an asynchronous job - one that will be automatically canceled if the calling job, effect, or event listener is canceled.  (Jobs are also promise-like, with `then`/`catch`/`finally`, and can be `await`ed by async functions.)

   Within a job function,`yield *until()` suspends the job to wait for a promise, event, another job, or a truthy signal value.  (And if the job is canceled, it automatically stops waiting and releases any listeners it set up.)

All three kinds of flows are **composable**: you can wrap a `when()` in an `effect()` in a `job()` and so on, in any order.

When an outer flow ends (whether by finishing normally, being canceled, or throwing an error), its inner flows are automatically ended as well.  This means that you don't have to do explicit resource management for event handlers and the like: it's all handled for you automatically.  (And as you'll see in the next section, you can also add explicit `onCleanup()` callbacks to release non-flow resources when the enclosing flow ends.)

Of course, all this flow composition has to start *somewhere*, and usually that will be one or more root-level `job()` calls.  (You can also start root-level flows with `effect.root()` or `when.root()`, or by wrapping them in a `track()`, as we'll see in the next section.)

### Resource Tracking and Cleanup

Under the hood, flows are linked by *resource trackers*: collections of callbacks that run when the flow ends, to release resources, unsubscribe listeners, or do other cleanup operations.  Within your `effect()`, `when()` and `job()` functions, you can use `onCleanup(callback)` to add cleanup callbacks to the current flow.  When the enclosing flow ends, these callbacks are invoked in last-in-first-out order.

For a `job()`, any added callbacks are run when the job as a whole is finished or canceled.  But for `effect()` and `when()`, they're *also* run when dependent values change, or the monitored stream produces a new value.  This lets you write code like this:

```typescript
import { value, effect, onCleanup } from "uneventful";
this.selectedIndex = value(0);  // dynamic value

effect(() => {
    const selectedNode = this.nodes[this.selectedIndex()];
    if (selectedNode) {
        selectedNode.classList.add("selected");
        onCleanup(() => { selectedNode.classList.remove("selected"); });
    }
});
```

This code will add `.selected` to the class of the currently selected element (which can be changed with `this.selectedIndex.set(number)`).  But, it will also automatically *remove* the class from the *previously* selected item (if any), before applying it to the new one!  (The class will also be removed if the effect is canceled, e.g. by the termination of an enclosing flow.)

As a convenience, you can also return cleanup functions directly from `when()` and `effect()` handlers, without needing to wrap them with an `onCleanup()` call.

Resource tracking is normally managed for you automatically, but you can also manually manage them via the `tracker()` function and its methods.  You probably won't do that very often, though, unless you're creating a custom flow or stream operator, or integrating your root-level flows with another framework's explicit resource management.

For example, [Obsidian.md](https://obsidian.md/) plugins and components will usually want to `.register()` their flows in an explicit `track()` call, to ensure they're all stopped (and the resources released, events unhooked, etc.) when the plugin or component is unloaded:

```typescript
import { track } from "uneventful";

class SomeComponentOrPlugin extends obsidian.Component {
    onload() {
        this.register(track(() => {
            // create effect(), job() or when() flows here
            // (They will all be stopped and resources cleaned
            // up when the component is unloaded.)
        }));
    }
}
```

### Signals

#### Differences from Other Signal Frameworks

(If you're not familiar with other signal frameworks, please skip to the next section!  This bit is literally **just** about things that may confuse people who *are* familiar with other JavaScript-based signal frameworks.)

If you're coming to Uneventful from other signal frameworks, the first big thing you may notice is our terminology is a bit different.  That's because we try to use names that indicate what something is *used for*, rather than what something *is*, how it works, or what it's made of.

So, what other frameworks usually call a `signal()`, we call a `value()`, because what you use it for is to *store a value*.  And instead of `computed()`, we have `cached()`, because you use it to intelligently cache a function's results between changes, to avoid extra work.

The second big thing to be aware of is that Uneventful has an [innovative batching model](#batching-and-side-effects) that works differently (by which I mean *better*) than any other signal framework I'm aware of.  But if you're used to getting burned by other frameworks' gotchas, it may seem "too simple" at first.  So feel free to check out all the details if you want to deeply understand why and how Uneventful's model is so simple, yet still fulfills the same stringent consistency requirements as other frameworks.

#### Signal Objects

A signal is an *observable value*.  Specifically, it can be monitored by `effect()`,  `when()`, or `yield *until()`, in order to perform actions when it changes in certain ways.

Monitoring is automatic, in that you don't have to perform any explicit subscription operations.  Just reading the value of a signal (or calling a function that reads a signal) from within an `effect()` automatically subscribes the effect to be re-run when the signal changes.

Similarly, passing a signal (or a zero-argument function that reads one or more signals) to `when()` or `yield *until()` will create a subscription to be notified as soon as the signal (or function result) produces a truthy value.

All of these kinds of subscriptions will be ended when they're no longer needed (such as when the effect stops reading the signal value, or is canceled).

Signals in Uneventful are created with `value(initialvalue)`, and `cached(calcFunction)`.  `value()` objects are writable via a `set()` method, while `cached()` functions are read-only functions, returning the most recent return value of their wrapped function.  Calling a cached function will always return the same result, *unless* any of the signals it read during its last run have changed since then.

`cached()` functions are technically unnecessary, in that you could always just use plain signal-using functions without any wrapping.  But on a practical level, they improve efficiency by preventing unnecessary re-running of effects or redoing of expensive calculations.  A `cached()` function is guaranteed to be called no more than once per "batch" of updates to any of its dependencies, and it will not notify any of its subscribers if its result doesn't change.  (And, if it doesn't have any flows subscribed to it  (via `effect()`, `when()` `*until()`, etc.), it won't be re-run unless explicitly called.)

#### Batching and Side-Effects

**tl;dr version**: Uneventful keeps your "model" (values and cached functions) up-to-date immediately, while side-effects update your "views" in the following microtask.  If you don't care about more details than that, skip on to the next section!

**detailed technical version:**  Underneath every functional signal framework is a [complex web of logic](https://smuglispweeny.blogspot.com/2008/02/cells-manifesto.html) designed to make sure that side effects see *every consistent* application state, with no dirty reads or lost updates.

This means that if multiple side-effects depend on one signal, they must *all* be run *each* time that signal is changed (i.e. no "lost updates").  And conversely, if you change two different signals "at the same time" (like in a batch or transaction), no side-effects must ever see an intermediate state where only one of the two signals has changed.  (i.e., no "dirty reads".)

Uneventful provides these same guarantees, without you needing to *do* anything about it in particular, except to bear in mind that side-effects work a bit like `async` functions: just because you *call* one now, doesn't mean it *runs* now... and you *definitely* won't get the *result* now.  And just like with async functions, the soonest you'll get the result (or side-effects in this case) is the next microtask.  So if you write something like this:

```typescript
effect(() => {
    /* do something */
});

/* code expecting "something" to have been done */
```
...you're gonna have a hard time.

Instead, if you need to write code that runs "after" an effect, it needs to be done asynchronously: i.e., run by a promise, event stream, or job that's been triggered by the effect.  (Just like async functions results can only be seen by other async functions, or via `then()` callbacks.)  A side-effect can't even see the results of its *own* actions, let alone those of others.  (Except asynchronously.)

In practice, this limitation isn't a big deal because the normal use of side effects is to update your application's *views* (or other "external" systems), and while they need to see every consistent update, they usually don't need to see their own changes -- they are, after all, the ones *making* those changes!

Other signal frameworks don't usually make this distinction between side-effects and signals, however.  Instead, they usually require you to mark out batches (explicitly or implicitly) in order to see the results of *any* changes.  Uneventful side-steps this issue by treating side-effects differently than values and cached functions: if you change values outside of a side-effect, the changes are *immediately* visible to your code, even when you call cached functions.

This doesn't result in dirty reads, though, because cached functions are only run when you explicitly *call* them.  So if you set value `A`, then set value `B`, and finally call the cached function `getAPlusB()`, it will only be called *once*, with both A and B changed.  And if a later side-effect *also* calls it, it will get the cached result from the earlier call, unless A or B got changed again in the meantime.

This approach avoids the need to explicitly manage batching and update visibility outside side-effect code.  Which is very important, because it means you can write signal-using APIs without needing the code *using* the API to know anything about signals. (That is, the downside to the approach other frameworks use, is that code that calls into a signal-using API will usually need to know about the specific frameworks' signal batching strategy and very likely its API as well!)

In short: values and cached functions are for representing your application's *model*, and side-effects are for updating its *views*.  And if on some rare occasion you need to update the model from within a side-effect or see a downstream effect, you can still do it asynchronously.

### Streams

### Jobs



## Current Status

This library is currently under development, but the ideas and most of the implementation are already working well as a draft version inside [@ophidian/core](https://github.com/ophidian-lib/core), for creating complex interactive Obsidian plugins.  The draft version is based on preact-signals for its signals implementation and wonka for its streams, but both will be replaced with uneventful-native implementations in this library, to drop the extra wrapping code, streamline some features, and add others.  (For example, preact-signals doesn't support nested effects and wonka doesn't support stream errors; uneventful will support both.)

