import { afterEach, beforeEach, clock, describe, expect, it, log, logUncaught, see, spy, useClock, useContext } from "./dev_deps.ts";
import { currentCell, currentCtx, popCtx, pushCtx } from "../src/ambient.ts";
import {
    CleanupFn, Context, Job, Result, Suspend, Task, currentContext, getResult, isCancel, isHandled, inContext, isValue,
    must, nativePromise, newRoot, noop, restarting, root, start, starting, Work, Scope, sleep, ActivityFn, Eventual,
    timeoutAfter
} from "../src/mod.ts";
import { rule, runRules } from "../src/signals.ts";
import { Cell } from "../src/cells.ts";
import { _Job } from "../src/tracking.ts";
import { catchers, defaultCatch, Maybe, owners } from "../src/internals.ts";
import { boundTo } from "../src/utils.ts";
import { expectType, TypeEqual } from "ts-expect";

describe("Checkpoint", () => {
    describe(".reset() ", () => {
        useClock();
        it("doesn't permanently terminate the checkpoint", () => {
            // Given a reset checkpoint
            const f = new _Job().reset();
            // When new cleanups are added to the checkpoint
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they don't run until the next reset
            clock.runAll(); see();
            f.reset(); see("release()", "must()");
            // Or next end
            f.release(() => log("release()2"));
            f.must(() => log("must()2"));
            clock.runAll(); see();
            f.end(); see("release()2", "must()2");
        });
        it("passes CancelResult to cleanups", () => {
            const f = new _Job();
            f.must(r => log(isCancel(r)));
            f.reset();
            see("true");
        });
        describe("won't revive an ended checkpoint", () => {
            it("after the end()", () => {
                // Given an ended checkpoint
                const r = new _Job(); r.end();
                // When reset is called
                // Then it should throw
                expect(() => r.reset()).to.throw("Work already ended")
            });
            it("during the end()", () => {
                // Given a checkpoint with a callback that runs reset
                const f = new _Job();
                f.must(() => {
                    try { f.reset(); } catch(e) { log(e); }
                })
                // When the checkpoint is ended
                f.end();
                // Then the reset attempt should throw
                see("Error: Work already ended");
            });
        });
    });
})

describe("_Job Implementation", () => {
    it("creates new standalone jobs", () => {
        const job1 = new _Job(), job2 = new _Job();
        expect(job1.end).to.be.a("function");
        expect(job2.end).to.be.a("function");
        expect(job1).to.not.equal(job2);
    });

    describe(".end() makes future cleanups run async+asap", () => {
        useClock();
        it("makes future must() + un-canceled release() run async+asap", () => {
            // Given an ended context with some cleanups
            const f: Scope = new _Job(); f.end();
            // When new cleanups are added to the context
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they run asynchronously
            clock.tick(0); see("release()", "must()");
        });
        it("doesn't run canceled release()", () => {
            // Given an ended scope with a cleanup
            const f: Scope = new _Job(); f.end();
            f.must(() => log("this should still run"));
            // When a release() is added and canceled
            f.release(() => log("this won't"))();
            // Then it should not be called, even though the
            // first cleanup is
            clock.tick(0); see("this should still run");
        });
    });
    describe("creates child tasks,", () => {
        var f: Scope, cb = spy();
        beforeEach(() => { cb = spy(); f = new _Job(); });
        it("calling the stop function if outer is cleaned up", () => {
            new _Job(f, cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("not calling the stop function if inner is cleaned up", () => {
            const inner = new _Job(f, cb);
            expect(cb).to.not.have.been.called;
            inner.end();
            f.end();
            expect(cb).to.not.have.been.called;
        });
        it("cleaning up the inner as the default stop action", () => {
            const inner = new _Job(f);
            inner.must(cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
    });
});

describe("Cancelled coroutines with `finally` clauses", () => {
    useContext()
    useClock()

    it("resume only after every subtask and peer activity has fully cleaned up", () => {
        // Given a started coroutine paused after subtask creation and registered cleanup
        const w = starting(function *mainTask() {
            start(function *subTask() {
                log("subtask start")
                must(msg("cleanup: child task"))
                yield noop
            })

            yield *sleep(0)  // Give the subtask a chance to start+pause
            see("subtask start")

            try {
                must(msg("cleanup: own scope"))
                log("pausing")
                yield noop
            } finally {
                log("coroutine finally")
            }
        })
        clock.runAll()
        see("pausing")

        // When the task is canceled
        w.end()

        // Then the coroutine `finally` should run *after* the subtask is cleaned up,
        // but *before* cleanups from the same scope
        see("cleanup: child task",
            "coroutine finally",
            "cleanup: own scope",
        )
    })

    it("skip the remainder of a `finally` that suspends", () => {
        // Given a running coroutine that suspends in a finally that pauses
        const w = starting(function* () {
            try {
                yield noop
            } finally {
                yield () => log("resumed")  // should never call this
            }
        })
        clock.runAll()
        // When it's ended
        w.end()
        // Then the finally's suspend function should not run
        see()
    })

    it("still dispose `using` bindings even if `finally` suspends", () => {
        // Given a running coroutine with a `using` disposable and a yielding `finally`
        const w = starting(function* () {
            using x = { [Symbol.dispose]: () => log("disposed") }
            try { yield noop } finally { yield noop }
        })
        clock.tick(0)
        // When the task is canceled
        w.end()
        // Then the disposable should be disposed
        see("disposed")
    })

    it("route completion errors in `finally` to the parent context", () => {
        // Given a running task that .return()s in a finally with a parent catching its async errors
        const parent = starting().asyncCatch(log)
        const w = parent.starting<number>(function* (self) {
            try { yield noop; return 42 }
            finally { self.return(1) }  // throws "already ended" (task ended)
        })
        clock.tick(0)
        // When it's ended
        w.end()
        // Then the finally's error should propagate to the parent
        see("Error: Work already ended")
    })
})

describe("newRoot()", () => {
    it("returns a new scope, ending the previous one", () => {
        // Given a root scope
        const r1 = newRoot().must(msg("old root stopped"))
        see()
        // When newRoot is called
        const r2 = newRoot()
        // Then the old root should stop
        see("old root stopped")
        // And it should return the new root
        expect(root).to.equal(r2)
        // Not the old one
        expect(root).to.not.equal(r1)
    });
    it("ensures root will be reset to null when the scope ends", () => {
        // Given a root scope
        const r1 = newRoot()
        expect(root).to.equal(r1)
        // When the scope ends
        r1.end()
        // Then root should be null
        expect(root).to.equal(null)
    });
    it("configures a default asyncCatch from the previous root", () => {
        // Given a new root
        const r1 = newRoot()
        // When a child task asynchronously throws
        r1.starting().throw("blah")
        // Then our default test logger should catch it (kept previous root default)
        see("Uncaught: blah")
        // And the root should not crash
        expect(root).to.equal(r1)
        try {
            // But if we configure our own asyncCatch
            r1.asyncCatch(e => log(`caught ${e}`))
            // And do another async throw
            r1.starting().throw("blah1")
            // Then our overridden handler should catch it
            see("caught blah1")
            // And when another root is created w/another throw
            const r2 = newRoot()
            r2.starting().throw("blah2")
            // Then our overridden handler should still be valid
            see("caught blah2")
        } finally {
            newRoot().asyncCatch(logUncaught)
        }
    });
    it("falls back to the default asyncCatch when the previous root's was cleared", async () => {
        // Given a root with its inherited asyncCatch handler cleared
        newRoot().asyncCatch(null)
        // When a new root is created
        const r2 = newRoot()
        try {
            // And a child task asynchronously throws
            r2.starting().throw("blah")
            // Then the error should eventually reach the default handler
            await new Promise(res => { setTimeout(res, 0) });
            see("rejected: blah")
            // And the new root should carry the default handler
            expect(catchers.get(r2)).to.equal(defaultCatch)
        } finally {
            // Restore the test logging default for later suites
            newRoot().asyncCatch(logUncaught)
        }
    });
    it("becomes the effective parent of reset checkpoints ", () => {
        // Given a checkpoint on the current root
        const oldRoot = root
        const ctx = root.checkpoint()
        // When a new root is created
        const r = newRoot()
        // Then the checkpoint's parent should not be the old root
        expect(owners.get(ctx)).to.not.equal(oldRoot)
    })
});

describe("start(action)", () => {
    it("doesn't run without a current context", () => {
        expect(() => start(()=>{})).to.throw("No context is current");
    });
    it("links to the enclosing context", () => {
        // Given a task created within another
        const task = root.start(() => {
            start(() => () => log("cleanup"))
        });
        see();
        // When the outer task is disposed
        task.end();
        // Then the inner task should be cleaned up
        see("cleanup");
    });
    it("waits for a promise (passed or returned)", async () => {
        // Given tasks wrapping passed or returned promises
        const j1 = root.start(async () => { return 42; });
        const j2 = root.start(Promise.reject("boom"));
        // When the promises resolve or reject
        // Then the result should become the task's result
        await expect(j1).to.eventually.equal(42);
        await expect(j2).to.be.rejectedWith("boom");
        see("Uncaught: boom");
    });
    it("waits for a returned task", async () => {
        // Given tasks wrapping returned tasks
        const j1 = root.start(() => { return starting<number>().return(42).task(); });
        const j2 = root.start(() => { return start(work => { work.task().onError(noop); work.throw("boom") }); });
        expect(j1.result()).to.be.undefined;
        expect(j2.result()).to.be.undefined;
        // They should eventually match their returned tasks' results
        await expect(j1).to.eventually.equal(42);
        await expect(j2).to.be.rejectedWith("boom");
        see("Uncaught: boom");
    });
    it("throws when given other objects or values", () => {
        for(const item of [42, "blah", {x:"y"},] as any[]) {
            for(const v of [item, () => item]) {
                try {
                    root.start(v);
                } catch(e) {
                    expect((e as any).message).to.equal("Invalid value/return for start/exec()");
                    continue;
                }
                log(`Should have thrown for ${item}, ${v}`);
            }
        }
        see(); // verify nothing logged
    });
    describe("with an enclosing task", () => {
        useContext();
        it("runs with a new task active, passing in the work", () => {
            const task = start((work) => {
                log(work === currentContext()); must(() => log("destroy"))
            });
            see("true"); task.end(); see("destroy");
        });
        it("adds the return value if it's a function", () => {
            const cb = spy();
            const task = start(() => cb as CleanupFn);
            expect(cb).to.not.have.been.called;
            task.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("cleans up on throw", () => {
            var cb = spy();
            expect(() => start(() => {
                must(cb);
                expect(cb).to.not.have.been.called;
                throw new Error("dang");
            })).to.throw("dang");
            expect(cb).to.have.been.calledOnce;
        });
    });
});

describe("Task API", () => {
    it("inContext() is true during run()", () => {
        var tested: Maybe<boolean>;
        expect(inContext(), "Shouldn't be current before run()").to.be.false;
        new _Job().run(()=> {
            expect(inContext(), "Should be current during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(inContext(), "Shouldn't be current after run()").to.be.false;
    });
    describe("calls methods on the current context", () => {
        var t1: Context, cb = spy();
        beforeEach(() => { t1 = new _Job(); cb = spy(); pushCtx(t1); });
        afterEach(() => { popCtx(); });
        it("must()", () => {
            const m = spy(t1, "must");
            must(cb);
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(t1);
        })
    });
    describe("throws when there's no current context", () => {
        const msg = "No context is current";
        it("currentContext()", () => { expect(currentContext).to.throw(msg); });
        it("must()", () => { expect(() => must(() => {})).to.throw(msg); });
    });
    describe("Typechecks correctly w/defaults and `this` bindings", () => {
        // Given a class with misc. task props
        class X {
            castNumber = start(boundTo(this, function*() { this.never; for(;;) yield noop } as ActivityFn<number, X>) )
            delegateNumber = start(boundTo(this, function*() { return yield *this.castNumber; }))
            never = start(boundTo(this, function*() { this.castNumber; for(;;) yield noop }))
            declaredString = start<string>(self => {})
            unboundString = starting(function*(s): Eventual<string> {return "blah"}, timeoutAfter(1))
        }
        // They should match their exepcted or delcared types
        it("for start()", () => {
            expectType<TypeEqual<Task<never>, X["never"]>>(true)
            expectType<TypeEqual<Task<number>, X["castNumber"]>>(true)
            expectType<TypeEqual<Task<number>, X["delegateNumber"]>>(true)
            expectType<TypeEqual<Task<string>, X["declaredString"]>>(true)
        })
        it("for starting", () => {
            expectType<TypeEqual<Work<string>, X["unboundString"]>>(true)
        })
    })
});

describe("Work contexts", () => {
    // Given a Work contxt
    var f: Work<number>;
    beforeEach(() => { f = new _Job(); });
    describe(".must()", () => {
        it("can be called without a callback", () => {
            f.must(); f.end();
        });
        it("calls the callback if given one", () => {
            const cb = spy();
            f.must(cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe("run .must() callbacks asynchronously in LIFO order", () => {
        useClock();
        it("when already end()ed", () => {
            // Given a canceled work context
            f.end();
            // When must() is called with two new callbacks
            f.must(() => log("first")).must(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("last", "first");
        });
        it("when already throw()n", () => {
            // Given a thrown work context
            f.throw(new Error); see("Uncaught: Error");
            // When must() is called with two new callbacks
            f.must(() => log("first")).must(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("last", "first");
        });
        it("while other .must callbacks are running", () => {
            // Given a work context with two must callbacks, one of which calls a third
            f
                .must(() => log("first"))
                .must(() => f.must(() => log("last")));
            // When the work is canceled
            f.end();
            // Then the newly-added callback should run immediately
            see("last", "first");
        });
    });
    describe(".end()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            f.must(c1); f.must(c2); f.must(c3);
            f.end();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks without an active context", () => {
            let hasContextOrCell: Maybe<boolean>;
            f.must(() => hasContextOrCell = !!(currentCtx || currentCell));
            pushCtx(f, {} as Cell);
            try { f.end(); } finally { popCtx(); }
            expect(hasContextOrCell).to.equal(false);
        });
        it("sends errors to the root scope", () => {
            const cb1 = spy(), cb2 = spy();
            f.must(cb1);
            f.must(() => { throw new Error("caught me!"); })
            f.must(cb2);
            f.end();
            see("Uncaught: Error: caught me!")
        });
        it("passes CancelResult to cleanups", () => {
            f.must(r => log(isCancel(r)));
            f.end();
            see("true");
        });
    })
    describe(".throw()", () => {
        it("propagates on an already ended task", () => {
            f.end();
            f.throw("boom"); see("Uncaught: boom");
            f = new _Job(); f.return(99);
            f.throw("boom"); see("Uncaught: boom");
            f = new _Job(); f.throw("blah"); see("Uncaught: blah");
            f.throw("boom"); see("Uncaught: boom");
        });
        it("passes an ErrorResult to callbacks", () => {
            f.task().onError(log);
            f.throw("pow");
            see("pow");
        });
    });
    describe(".return()", () => {
        it("Fails on an already ended task", () => {
            f.end();
            expect(() => f.return(42)).to.throw("Work already ended");
            f = new _Job(); f.return(99);
            expect(() => f.return(42)).to.throw("Work already ended");
            f = new _Job(); f.throw("blah"); see("Uncaught: blah");
            expect(() => f.return(42)).to.throw("Work already ended");
        });
        it("passes a ValueResult to callbacks", () => {
            f.must(r => log(isValue(r) && r.val));
            f.return(42);
            see("42");
        });
    });
    describe(".exec()", () => {
        useClock()
        it("is a no-op on an ended context", () => {
            root.starting<void>().return()
                .exec(msg("run"))
                .exec(function*(){ log("yield") })
                .exec({then(...args: any[]) { log("then!"); return this as any }})
            clock.runAll()
            see()
        })
    })
    describe(".release()", () => {
        it("calls the callback on cleanup", () => {
            const cb = spy();
            f.release(cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("can be cancelled", () => {
            const cb = spy();
            const cancel = f.release(cb);
            expect(cb).to.not.have.been.called;
            cancel();
            f.end();
            expect(cb).to.not.have.been.called;
        });
    });
    describe(".run()", () => {
        it("makes the context active", () => {
            var active: Maybe<Context>;
            expect(inContext()).to.be.false;
            f.run(() => { active = currentContext(); });
            expect(active).to.equal(f);
            expect(inContext()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = new _Job();
            expect(inContext()).to.be.false;
            f.run(() => {
                expect(currentContext()).to.equal(f);
                f1.run(() => expect(currentContext()).to.equal(f1));
                try {
                    f1.run(() => { throw new Error; });
                } catch (e) {
                    expect(currentContext()).to.equal(f);
                }
            });
            expect(inContext()).to.be.false;
        });
        it("passes through arguments and returns the result", () => {
            // When run is called with a function and arguments
            const res = f.run((...args) => args.map(log), 1, 2, 3);
            // Then the function should receive the arguments
            see("1", "2", "3")
            // And return its result
            expect(res).to.deep.equal([undefined, undefined, undefined]);
        });
    });
    describe(".task().result()", () => {
        useContext();
        useClock();
        it("can be observed by a rule or signal", () => {
            // Given a rule observing a pending task's result
            const work = root.starting<number>();
            const end = rule(() => {
                const res = work.task().result()
                if (res) log(`done: ${getResult(res)}`); else log(`loading...`);
            });
            // When rules are run, it should see the undefined result
            runRules(); see("loading...");
            // And after the task finishes it should see the final result
            work.return(42); clock.runAll(); runRules(); see("done: 42");
            end(); see();
        });
    });
    describe(".bind() returns a function that", () => {
        it("runs in the context", () => {
            var active: Maybe<Context>;
            expect(inContext()).to.be.false;
            f.bind(() => { active = currentContext(); })();
            expect(active).to.equal(f);
            expect(inContext()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = new _Job();
            expect(inContext()).to.be.false;
            f.bind(() => {
                expect(currentContext()).to.equal(f);
                f1.bind(() => expect(currentContext()).to.equal(f1))();
                try {
                    f1.bind(() => { throw new Error; })();
                } catch (e) {
                    expect(currentContext()).to.equal(f);
                }
            })();
            expect(inContext()).to.be.false;
        });
        it("passes through arguments and `this`", () => {
            // Given an object to use as `this`
            const ob = {};
            // When a bound function is called with a this and arguments
            const res = f.bind(function (this: any, ...args) { args.map(log); return this; }).call(ob, 1, 2, 3);
            // Then the function should receive the arguments
            see("1", "2", "3")
            // And return its result
            expect(res).to.equal(ob);
        });

    });

    function workWithHandlers<T>() {
        return root.starting<T>(w => {
            w.task()
            .onError(e => log(`Err: ${e}`))
            .onValue(v => log(`Val: ${v}`))
            .onCancel(() => log("cancel"))
        });
    }

    describe(".future().onValue()", () => {
        it("calls the callback with the value upon return", () => {
            // Given a Work with a future value handler
            const work = workWithHandlers<number>();
            // When the Work is return()ed
            work.return(42);
            // Then it should call the handler with the value
            see("Val: 42");
        });
    });
    describe(".future().onError()", () => {
        it("calls the callback with the error upon throw, marking the error handled", () => {
            // Given a Work with a future onError-logging handler
            const work = workWithHandlers();
            // That also logs the handling status before and after the onError handler
            function logHandled(r: Result<any>) { log(isHandled(r) ? "handled" : "not handled yet"); }
            work.must(logHandled).task().do(logHandled)  // must runs before, do runs after
            // When the Work is throw()n
            work.throw("boo");
            // Then it should call the handler with the error
            // and mark the error handled
            see("not handled yet", "Err: boo", "handled");
        });
    });
    describe(".future().onCancel()", () => {
        it("calls the callback after canceling", () => {
            // Given a Work with a future cancel handler
            const j = workWithHandlers();
            // When the Work is end()ed
            j.end();
            // Then it should call the handler
            see("cancel");
        });
    });
    describe(".future()[Symbol.iterator]", () => {
        describe("marks errors handled", () => {
            useClock()
            it("synchronously, after error ", () => {
                // Given a coroutine that's next()ed during throw
                const j = root.starting(), it = j.task()[Symbol.iterator]();
                j   // iterator should throw the error on next()
                    .must(() => { try {it.next();} catch(e) { log(`Err: ${e}`)}})
                    .must(r => log(isHandled(r))).task().do(r => log(isHandled(r)));
                // When it's thrown
                j.throw("boom");
                // Then the error result should be marked handled
                see("false", "Err: boom", "true");
            });
            it("asynchronously, before error", () => {
                // Given a work context + task iterator
                const j = root.starting(), it = j.task()[Symbol.iterator]();
                // When its Suspend is awaited and the work thrown
                (it.next().value as Suspend<any>)((op, _val, err) => { log(`${op}: ${err}`)});
                j.must(r => log(isHandled(r))).task().do(r => log(isHandled(r)));
                j.throw("boom"); clock.tick(0)
                // Then the error result should be marked handled when the suspend resumes
                see("false", "true", "throw: boom");
            });
        });
    });
});

describe("restarting()", () => {
    it("runs functions in call-specific checkpoints, until enclosing context ends", () => {
        // Given a restarting wrapper created in an outer context
        const outer = new _Job(), w = outer.bind(restarting)();
        let f1: Maybe<Context>, f2: Maybe<Context>;
        // When it's called with a function
        w(() => { f1 = currentContext(); log("called"); must(() => log("undo")); });
        // Then the function should run in a distinct context
        see("called");
        expect(f1).to.be.instanceOf(outer.constructor);
        expect(f1).to.not.equal(outer);
        // And when it's called with another function
        w(() => { f2 = currentContext(); log("another"); return () => log("undo 2"); });
        // Then it should run in the same context after restarting
        expect(f1).to.equal(f2);
        see("undo", "another");
        // And if the outer context ends, so should the inner
        outer.end();
        see("undo 2");
        // Following which, it should throw an error if called again:
        expect(() => w(() => log("this won't do"))).to.throw("Work already ended")
    });
    it("uses a different context for each wrapper", () => {
        // Given two restarting wrappers created in an outer context
        const outer = new _Job(), w1 = outer.bind(restarting)(), w2 = outer.bind(restarting)();
        let f1: Maybe<Context>, f2: Maybe<Context>;
        // When they are called
        w1(() => { f1 = currentContext(); });
        w2(() => { f2 = currentContext(); });
        // Then the functions should run in two different contexts
        expect(f1).to.be.instanceOf(outer.constructor);
        expect(f2).to.be.instanceOf(outer.constructor);
        expect(f1).to.not.equal(outer);
        expect(f1).to.not.equal(f2);
    });
    it("when given a function, matches its signature", () => {
        // Given a restarting wrapper around a function
        const outer = new _Job(), w = outer.bind(restarting)((a,b,c) => { log(a); log(b); log(c); return 42; });
        // When it is called
        const res = w("a", 22, 54);
        // Then it should receive any arguments
        see("a", "22", "54");
        // And return the result
        expect(res).to.equal(42);
    });
    it("resets when a synchronous error is thrown", () => {
        // Given a restarting wrapper around a function that synchronously throws
        const outer = new _Job(), w = outer.bind(restarting)(() => { must(()=> log("undo")); throw "whoops"; });
        // When the function is called, it should throw
        expect(w).to.throw("whoops");
        // And Then it should reset the checkpoint
        see("undo");
        expect(inContext()).to.be.false;
        expect(w).to.throw("whoops");
        see("undo");
    });
    it("throws async errors to its calling context from subtasks", () => {
        // Given a restarting wrapper around a function that async-throws
        const outer = new _Job().asyncCatch(e => { log(`caught: ${e}`)});
        const w = outer.bind(restarting)(() => { starting().throw("whoops"); });
        // When the wrapper is called
        w()
        // Then the error should pass to the outer context
        see("caught: whoops")
        // And the function should still be callable
        w()
        see("caught: whoops")
    });
    it("throws direct async errors to its calling context", () => {
        // Given a restarting wrapper around a function currentContext().throw()s
        const outer = new _Job().asyncCatch(e => { log(`caught: ${e}`)});
        const w = outer.bind(restarting)(() => { (currentContext() as Job).throw("whoops"); });
        // When the wrapper is called
        w()
        // Then the error should pass to the outer context
        see("caught: whoops")
        // But the function won't be callable
        expect(w).to.throw("Work already ended");
        see();
    });
    it("can be used as a method", () => {
        // Given a restarting-wrapped method
        const w = {m: new _Job().bind(restarting)(function (this: any) { log(this === w); })};
        // When called as a method
        w.m();
        // Then its `this` should be the object
        see("true")
    });
});

describe("nativePromise()", () => {
    describe("returns the same promise", () => {
        it("per task", () => {
            // Given a task and its nativePromise
            const j = root.start(noop), p1 = nativePromise(j);
            // When nativePromise is called again
            const p2 = nativePromise(j);
            // Then the promises should be equal
            expect(p1).to.equal(p2);
            // But be different from the nativePromise of another task
            expect(p1).to.not.equal(nativePromise(root.start(noop)))
        });
        describe("even after", () => {
            function shouldBeTheSame<T>(after: (work: Work<T>) => (Promise<T>|void)) {
                const j = root.starting<T>(), p = nativePromise(j.task()); p.catch(noop);
                expect(after(j) || nativePromise(j.task())).to.equal(p);
            }
            it("return", () => { shouldBeTheSame(work => { work.return(42); });    });
            it("throw",  () => { shouldBeTheSame(work => { work.throw("boom"); }); });
            it("cancel", () => { shouldBeTheSame(work => { work.end(); });         });
        });
        it("except on reset()", () => { // XXX resetting a task is deprecated
            // Given a task and its nativePromise
            const j = root.starting() as Job, p1 = nativePromise(j); p1.catch(noop);
            // When nativePromise is called again after restart
            j.reset();
            const p2 = nativePromise(j);
            // Then  the promises should be different
            expect(p1).to.not.equal(p2);
        });
    });
    it("marks errors handled", () => {
        // Given a Work context with a nativePromise on its task
        const work = root.starting(), p = nativePromise(work.task()); p.catch(noop);
        work.must(r => log(isHandled(r))).task().do(r => log(isHandled(r)))
        // When the work is thrown
        work.throw("boom");
        // Then the error should be marked handled
        see("false", "true");
    });
});

function msg(val: any) { return () => log(val); }

describe("Cleanup order", () => {
    function setupTasks() {
        const tasks = [] as Task<any>[];
        tasks.unshift(root.start(j => {
            log("starting @ root");
            must(msg("must @ root"));
            j.release(msg("release @ root"));
            for (const i of [1, 2, 3]) tasks.push(start(j => {
                log(`starting @ sub ${i}`);
                must(msg(`must @ sub ${i}`));
                j.release(msg(`release @ sub ${i}`));
            }).do(msg(`do @ sub ${i}`)));
        }).do(msg("do @ root")));
        see("starting @ root", "starting @ sub 1", "starting @ sub 2", "starting @ sub 3");
        return tasks;
    }

    it("runs all child release()s before *any* must()s or do()s", () => {
        // Given some nested tasks
        const [j] = setupTasks();
        // When the parent task is ended
        j.end();
        // Then the release()s should run breadth-first, followed by depth-first
        // LIFO for must()s + FIFO for do()s
        see(
            "release @ sub 3", "release @ sub 2", "release @ sub 1", "release @ root",
            "must @ sub 3", "do @ sub 3",
            "must @ sub 2", "do @ sub 2",
            "must @ sub 1", "do @ sub 1",
            "must @ root",  "do @ root"
        )
    });

    it("runs .reset() cleanups to completion before resuming other cleanups", () => {
        // Given some nested tasks, with a checkpoint that's restarted by one of them in a cleanup
        const [j, _j1, j2, _j3] = setupTasks();
        const toReset = root.checkpoint()
        toReset.run(() => {
            must(msg("must @ reset"));
            start(() => msg("must @ reset sub"));
        });
        (j2 as Job).must(() => { log("reset begins"); toReset.reset(); log("reset done"); })
        // When the root is ended
        j.end()
        // Then the reset should run its own full cleanup tree
        // before resuming the enclosing one
        see(
            "release @ sub 3", "release @ sub 2", "release @ sub 1", "release @ root",
            "must @ sub 3", "do @ sub 3",

            "reset begins",
            "must @ reset sub",
            "must @ reset",
            "reset done",

            "must @ sub 2", "do @ sub 2",
            "must @ sub 1", "do @ sub 1",
            "must @ root",  "do @ root"
        )
    });
});
