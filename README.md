## uneventful: signals plus streams, minus the seams

#### The Problem
Event-driven programming creates a lot of *garbage*.  Whether you're using raw event handlers or some kind of functional abstraction (like streams or signals or channels), the big issue with creating complex interactivity is that at some point, you have to *clean it all up*.

Handlers need to be removed, requests need to be canceled, streams unsusbcribed or channels closed, and a whole bunch more.  And if you don't do it *just right*, you get **bugs**, hiding in your leftover garbage.

Worse, the need to keep track of *what* garbage to get rid of and *when* to do it breaks functional composition and information hiding.  You can't just write functions that *do* things, because they need to either return disposal information or have it passed into them.

Sure, reactive stream and signal libraries help with this some, by giving you fewer things to dispose of, or giving you some tools to dispose of them with.  But both paradigms have their limits: when you start doing more complex interactions, you usually end up needing ever-more complex stream operators, or signal-based state machines.

And so, while your code *is* a bit cleaner, the complexity and clutter hasn't really gone away: it's just moved to the mind of the person *reading* your code.  (Like you, six months later!)

#### The Solution
Enter Uneventful: a seamless, *declarative*, and **composable** blend of signals, streams, and CSP-like, cancelable asynchronous jobs (aka structured concurrency) with automatic resource management.

Uneventful does for event-driven interaction what async functions did for promises: it lets you build things out of *functions*, instead of spaghetti and garbage.  It's a system for *composable interactivity*, unifying and composing all of the current reactive paradigms in a way that hides the seams and keeps garbage collection where it belongs: hidden in utility functions, not cluttering up your code and your brain.

And it does all this by letting your program structure *reflect its interactivity:*

```ts
import { start, pipe, into, fromDomEvent, must, Job } from "uneventful";

function drag(node: HTMLElement): Job<HTMLElement> {
    return start(job => {
        // The dragged item needs a dragging class during the operation
        addDragClass(node);

        // The item position needs to track the mouse movement
        trackMousePosition(node);

        // The job ends when the mouse button goes up,
        // returning the DOM node it happens over
        pipe(fromDomEvent(document, "mouseup"), into(e => {
            // Exit the job, removing all the listeners (and the .dragging class)
            job.return(e.target);
        }));
    });
}

function addDragClass(node: HTMlElement) {
    node.classList.add("dragging");  // Add a class now
    must(() => node.classList.remove("dragging"));  // Remove it when the job is over
}

function trackMousePosition(node: HTMLElement) {
    pipe(fromDomEvent(document, "mousemove"), into(e => {
        // ... assign node.style.x/.y from event
    }));
}
```

The example above is a sketch of a drag-and-drop operation that can be *called as a function*.  It returns a Job, which is basically a cancellable Promise.  (With a bunch of extra superpowers we'll get to later.)  Other jobs can wait for it to complete, or you can `await` it in a regular async function if you want.

You've probably noticed that there isn't any code here that unsubscribes from anything, and that the only explicit "cleanup" code present is the `must()` call in `addDragClass()`.  That's because Uneventful keeps track of the "active" job, and has APIs like `must()` to register cleanup code that will run when that job is finished or canceled.  This lets you move the garbage collection to *precisely* where it belongs in your code: **the place where it's created**.

If you're familiar with [statecharts](https://statecharts.dev/what-is-a-statechart.html), you might notice that this code sample can easily be translated to one, and the same is true in reverse: if you use statecharts for design and uneventful for implementation, you can pretty much *write down the chart as code*.  (A job definition function is a state, and each job instance at runtime represents one "run" of that state, from entry to exit.  And of course job definitions can nest like states, and be named and abstracted away like states.)

But Uneventful is actually *better* than statecharts, even for design purposes: instead of following boxes and lines, your code is a straightforward list of substates, event handlers, or even *sequential activities*:

```ts
import { each } from "uneventful";

function supportDragDrop(node: HTMLElement) {
    return start(function*(job) {
        const mouseDown = fromDomEvent(node, "mousedown");
        for (const {item: node, next} of yield *each(mouseDown)) {
            const dropTarget = yield *drag(node);
            // do something with the drop here
            yield next;  // wait for next mousedown
        });
    });
}
```

Where our previous job did a bunch of things in parallel, this one is *serial*.  If the previous job was akin to a Promise constructor, this one is more like an async function.  It loops over an event like it was an async iterator, but it does so semi-synchronously.  (Specifically, each pass of the loop starts *during* the event being responded to, not in a later microtask!)

Then it starts a drag job, and waits for its completion, receiving the return value in much the same way as an `await` does -- but again, semi-synchronously, during the mouseup event that ends the `drag()` call.  (Note: this synchronous return-from-a-job is specific to using `yield` in another job function: if you `await` a job or call its `.then()` method to obtain the result, it'll happen in a later microtask as is normal for promise-based APIs.)

And though we haven't shown any details here of what's being *done* with the drop, it's possible that we'll kick off some additional jobs to do an animation or contact a server or something of that sort, and wait for those to finish before enabling drag again.  (Unless of course we *want* them to be able to overlap with additional dragging, in which case we can spin off detached jobs.)

#### Context, Cancellation, and Cleanup
If you look closely, you might notice that our last example is an *infinite loop*.  `fromDomEvent` returns a stream that will never end on its own, so we could in fact declare this function as returning `Job<never>` -- i.e. a promise that will never return a value.  (But it can still throw an error, or be canceled.)

So how does it *exit*?  When do the event handlers get cleaned up?

Well, that's up to the *caller*.  If the calling job exits, then any unfinished jobs "inside" it are automatically canceled.  (It can also explicitly cancel the job, of course.)

For jobs implemented via a setup function (like `drag()`) this just means that all `must()` callbacks registered with that job will be invoked, in reverse order.  For a job implemented as a generator (like `supportDragDrop()`), it also means that the most recent `yield` will be resumed as if it had been a `return` instead, allowing any enclosing `try` /`finally` blocks to run.

In order for all this to work, of course, Uneventful has to keep track of the "active" job, so that `must()` callbacks and nested jobs can be linked to the correct owner.  (You can also do this linking explicitly, e.g. by directly calling a specific job's `.start()` or `.must()` methods instead of the standalone versions.)  The way it works is this:

- If you're in the body of a `start()` function, that job is active
- if you're in the body of a `start()`-ed *generator* function, the same applies, but also any generator functions you `yield *` to in the generator function will still have the job active.
- Callbacks **must** be wrapped with `restarting()` or a job's `.bind()` method (or invoked via a job's `.run()` method) in order to have a job active.
- If you're in a function directly called from an any place where there's an active job, that job is still active.

Early versions of Uneventful also tried to automatically wrap event handlers to run in their owning jobs, but it turned out that this is fairly wasteful in practice!  Most event handlers are defined inside of jobs, and so have easy access to their job instance in a variable (as provided by `start()`).  So they can explicitly target `job.start()` or `job.must()` to create subjobs or register cleanups, etc., without needing an implicit current job.

(Also, as in our `supportDragDrop()` example, you can just loop over `yield *each()` and avoid callbacks entirely!)

So the main place where you're likely to want to wrap an event handler is when you want events to start an operation that might be superseded by a *later* event of the same kind.  For example, if you want to make a folder open in your UI when a drag hovers over it for a certain amount of time:

```ts
import {restarting, sleep} from "uneventful";

start(job => {
    pipe(currentlyHoveredFolder, into(restarting(folder => {
        if (folder && !folder.isOpen()) start(function *(job) {
            yield *sleep(300);
            // ... open the folder here
        });
    })));
});
```

Let's say that `currentlyHoveredFolder` is a stream that sends events as the hover state changes: either a folder object or `null` if no hovering is happening.  The `restarting()` API wraps the event handler with a "temp" job that is canceled and restarted each time the function is called.

With this setup, the "open the folder here" code will only be reached if the hover time on a given folder exceeds 300ms.  Otherwise, the next change in the hovered folder will cancel the sleeping job (incidentally clearing the timer ID allocated by the `sleep()` as it does so).

Now, in this simple example you *could* just directly do the debouncing by manipulating the stream.  And for a lot of simple things, that might even be the best way to do it.  Some event driven libraries might even have lots of handy built-in ways to do things like canceling your in-flight ajax requests when the user types in a search field.

But the key benefit to how Uneventful works is that you're not *limited* to whatever bag of tricks the framework itself provides: you can just **write out what you want** and it's easily cancellable by *default*, without you needing to try to twist your use case to fit a specific trick or tool.

#### Signals and Streams, Minus The Seams
So far our examples haven't really used anything "fancy": we've only imported eight functions and a type!  But Uneventful also provides a collection of reactive stream operators roughly on par with Wonka.js, and a reactive signals API comparable to that of Maverick Signals.  So you can `pipe()`, `take()`, `skip()`, `map()`, `filter()` or even `switchMap()` streams to your heart's content.  (See the Stream Operators section of the docs for the full list.)

Uneventful's signals and effects are named and work slightly differently from most other frameworks, though.  In particular, what other framework APIs usually call a "signal", we call a *value*.  What others call "computed", we call a *cached function*.  And what they call an "effect", we call a *rule*.  (With the respective APIs being named `value()`, `cached()`, and `rule()`.  We still call them "signals" as a category, though.)

Why the differences?  Uneventful is all about *making clear what your code is doing*.  A "signal" is just an **observable value** that you can change.  A "computed" value is just a function whose value you don't *want* to recompute unless its dependencies change: that is, it's a **cached function**.  And when you write an "effect" you're really defining a **rule for synchronizing state**.

(But of course, if you're migrating from another signal framework, or are just really attached to the more obscure terminology, you can still rename them in your code with `import as`!)

Beyond these superficial differences, though, there are some deeper ones.  Unlike other libraries' "effects", Uneventful's rules *start asynchronously* and can be *independently scheduled*.  This means, for example, that it's easy to make rules that run only in, say, animation frames:

```ts
import { RuleScheduler } from "uneventful";

/**
 * An alternate version of rule() that runs in animation frames
 * instead of microticks
 */
const animate = RuleScheduler.for(requestAnimationFrame).rule;

animate(() => {
    // Code here will not run until the next animation frame.
    // After that, though, it'll be *rerun* in another animation frame,
    // any time there's a change to a `value()` or `cached()` it read
    // in its previous run.
    //
    // It's also run in a `restarting()` job, allowing it to register
    // must() functions that will be called on the next run, or when
    // the enclosing job ends.  (It can also define other rules or
    // start jobs, which will be similarly canceled and restarted if
    // dependencies change, or if the jobs/rules/etc. containing this
    // rule are finished, canceled, or restarted!)
});
```

As in most of the better signal frameworks, Uneventful rules can be nested inside of other rules.  But they can *also* be nested in jobs, and vice versa: if a rule starts a job, it's contained in the rule's restarting job, and canceled/started over if any of the rule's dependencies change.

Also unlike other frameworks, you can have rules that run on different schedules, and nest and combine them to your heart's content.  For example, you can use a default, microtask-based `rule()` that decides *whether* an animation rule inside it should be active, or does some of the heavier computation first so the actual animation rule has less to do during the animation frame.

Schedulers also let you appropriately debounce or sample changes for some of your rules so you can avoid unnecessary updates.  Instead of requiring an immediate response to every change of an observable value, or explicit batching declarations, Uneventful just marks dependencies dirty, and queues affected rules to be run by their corresponding scheduler(s).

(This means, for example, that you can have rules that update data models immediately, other rules that update visible UI in the next animation frame, and still others that update a server or database every few seconds, without needing anything more complicated than using rule functions tied to different schedulers when creating them.)

#### What's Next
So far, we've highlighted just a handful of Uneventful's coolest and most impactful features, showing how you can:

- Use the best-fit tools from every major reactive paradigm, from signals, streams, and CSP, to cancelable async processes and structured concurrency -- while still being interoperable with standard APIs like promises, async functions, and abort signals
- Make your code's interactivity *visible* and *composable*, such that serial and parallel job flows are obvious in your code, or hidden away within functions, as required, while easily expressing interactions that would be challenging in other paradigms
- Play well with state charts, or ignore the charts and just express interactivity directly in code!
- Easily control the *timing* of operations, building advanced debouncing and sampling with basic async operators like `sleep()` or by defining rules tied to a scheduler

And at the same time, this has actually been a pretty superficial tour: we haven't gotten into a lot of things like how to actually *use* signals or abort jobs or any other details, really.  For those, you'll currently have to dig through the API Reference, but there should be more tutorials and guides as time goes on.

(Also, at some point you'll be able to use the "Calibre Connect" Obsidian plugin I'm working on as an example of how to use these things to create responsive search and tame Electron WebFrames while keeping track of whether a connection to a remote server is available, handling logins and background processes and integrating a plugin to a larger application, not to mention controlling lots of features via settings.)

In the meantime, this library should shortly be available via npm.  Enjoy!

