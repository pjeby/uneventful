import { afterEach, beforeEach, clock, describe, expect, it, log, see, spy, useClock, useRoot } from "./dev_deps.ts";
import { current, freeCtx, makeCtx, swapCtx } from "../src/ambient.ts";
import { noop, CleanupFn, Job, start, isJobActive, must, detached, makeJob, getJob, isCancel, isError, isValue, restarting, isHandled, JobResult } from "../mod.ts";
import { Cell } from "../src/cells.ts";

describe("makeJob()", () => {
    it("returns new standalone jobs", () => {
        const job1 = makeJob(), job2 = makeJob();
        expect(job1.end).to.be.a("function");
        expect(job2.end).to.be.a("function");
        expect(job1).to.not.equal(job2);
    });
    describe(".restart() ", () => {
        useClock();
        it("doesn't permanently terminate the job", () => {
            // Given a restarted job
            const f = makeJob(); f.restart();
            // When new cleanups are added to the job
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they don't run until the next restart
            clock.runAll(); see();
            f.restart(); see("release()", "must()");
            // Or next end
            f.release(() => log("release()2"));
            f.must(() => log("must()2"));
            clock.runAll(); see();
            f.end(); see("release()2", "must()2");
        });
        it("passes CancelResult to cleanups", () => {
            const f = makeJob();
            f.must(r => log(isCancel(r)));
            f.restart();
            see("true");
        });
        describe("won't revive an ended job", () => {
            it("after the end()", () => {
                // Given an ended job
                const r = makeJob(); r.end();
                // When restart is called
                // Then it should throw
                expect(() => r.restart()).to.throw("Job already ended")
            });
            it("during the end()", () => {
                // Given a job with a callback that runs restart
                const f = makeJob();
                f.must(() => {
                    try { f.restart(); } catch(e) { log(e); }
                })
                // When the job is ended
                f.end();
                // Then the restart attempt should throw
                see("Error: Job already ended");
            });
        });
    });
    describe(".end() makes future cleanups run async+asap", () => {
        useClock();
        it("makes future must() + un-canceled release() run async+asap", () => {
            // Given an ended job with some cleanups
            const f = makeJob(); f.end();
            // When new cleanups are added to the job
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they run asynchronously
            clock.tick(0); see("release()", "must()");
        });
        it("doesn't run canceled release()", () => {
            // Given an ended job with a cleanup
            const f = makeJob(); f.end();
            f.must(() => log("this should still run"));
            // When a release() is added and canceled
            f.release(() => log("this won't"))();
            // Then it should not be called, even though the
            // first cleanup is
            clock.tick(0); see("this should still run");
        });
    });
    describe("creates nested jobs,", () => {
        var f: Job, cb = spy();
        beforeEach(() => { cb = spy(); f = makeJob(); });
        it("calling the stop function if outer is cleaned up", () => {
            makeJob(f, cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("not calling the stop function if inner is cleaned up", () => {
            const inner = makeJob(f, cb);
            expect(cb).to.not.have.been.called;
            inner.end();
            f.end();
            expect(cb).to.not.have.been.called;
        });
        it("cleaning up the inner as the default stop action", () => {
            const inner = makeJob(f);
            inner.must(cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
    });
});

describe("start(action)", () => {
    it("doesn't run without an enclosing job", () => {
        expect(() => start(()=>{})).to.throw("No job is currently active");
    });
    it("links to the enclosing job", () => {
        // Given a job created within a standalone job
        const job = detached.start(() => {
            start(() => () => log("cleanup"))
        });
        see();
        // When the outer job is disposed
        job.end();
        // Then the inner job should be cleaned up
        see("cleanup");
    });
    describe("with an enclosing job", () => {
        useRoot();
        it("runs with a new job active, passing in the job", () => {
            const job = start((job) => {
                log(job === getJob()); must(() => log("destroy"))
            });
            see("true"); job.end(); see("destroy");
        });
        it("adds the return value if it's a function", () => {
            const cb = spy();
            const job = start(() => cb as CleanupFn);
            expect(cb).to.not.have.been.called;
            job.end();
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

describe("detached", () => {
    function cantDoThat(fn: () => any) {
        expect(fn).to.throw("Can't do that with the detached job");
    }
    it("doesn't allow must(), do(), and other callback-based operations", () => {
        cantDoThat(() => detached.must(noop));
        cantDoThat(() => detached.do(noop));
    });
    it("refuses to end(), restart(), return(), throw(), etc.", () => {
        cantDoThat(detached.end);
        cantDoThat(() => detached.restart());
        cantDoThat(() => detached.return(42));
        cantDoThat(() => detached.throw("boom"));
    });
    it("returns noop from .release()", () => {
        expect(detached.release(() => log("whatever"))).to.equal(noop);
    });

    it("allows creating 'nested' jobs", () => {
        // Given a detached job factory that creates a job
        const job = detached.bind(() => start(() => {
            must(() => log("cleanup"));
        }))();
        see();
        // When the job's cleanup is called
        job.end();
        // Then cleanups registered in the job should run
        see("cleanup");
    });
});

describe("Job API", () => {
    it("isJobActive() is true during run()", () => {
        var tested: boolean;
        expect(isJobActive(), "Shouldn't be active before run()").to.be.false;
        makeJob().run(()=> {
            expect(isJobActive(), "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(isJobActive(), "Shouldn't be active after run()").to.be.false;
    });
    describe("calls methods on the active job", () => {
        var t1: Job, cb = spy();
        beforeEach(() => { t1 = makeJob(); cb = spy(); current.job = t1; });
        afterEach(() => { current.job = undefined; });
        it("must()", () => {
            const m = spy(t1, "must");
            expect(must(cb)).to.equal(t1);
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(t1);
        })
    });
    describe("throws when there's no active job", () => {
        const msg = "No job is currently active";
        it("getJob()", () => { expect(getJob).to.throw(msg); });
        it("must()", () => { expect(() => must(() => {})).to.throw(msg); });
    });
});

describe("Job instances", () => {
    // Given a job
    var f: Job;
    beforeEach(() => { f = makeJob(); });
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
            // Given an ended job
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
            // Given a thrown job
            f.throw(new Error);
            // When must() is called with two new callbacks
            f.must(() => log("first")).must(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("last", "first");
        });
        it("while other .must callbacks are running", () => {
            // Given a job with two must callbacks, one of which calls a third
            f
                .must(() => log("first"))
                .must(() => f.must(() => log("last")));
            // When the job is ended
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
        it("runs callbacks without an active job or cell", () => {
            let hasJobOrCell: boolean = undefined;
            f.must(() => hasJobOrCell = !!(current.job || current.cell));
            const old = swapCtx(makeCtx(f, {} as Cell));
            try { f.end(); } finally { freeCtx(swapCtx(old)); }
            expect(hasJobOrCell).to.equal(false);
        });
        it("converts errors to unhandled rejections", async () => {
            const cb1 = spy(), cb2 = spy();
            f.must(cb1);
            f.must(() => { throw new Error("caught me!"); })
            f.must(cb2);
            f.end();
            const reason = await new Promise<Error>(res => {
                process.on("unhandledRejection", handler);
                function handler(e: any) {
                    process.off("unhandledRejection", handler);
                    res(e);
                }
            });
            expect(reason.message).to.equal("caught me!");
        })
        it("passes CancelResult to cleanups", () => {
            f.must(r => log(isCancel(r)));
            f.end();
            see("true");
        });
    })
    describe(".throw()", () => {
        it("Fails on an already ended job", () => {
            f.end();
            expect(() => f.throw("boom")).to.throw("Job already ended");
            f = makeJob(); f.return(99);
            expect(() => f.throw("boom")).to.throw("Job already ended");
            f = makeJob(); f.throw("blah");
            expect(() => f.throw("boom")).to.throw("Job already ended");
        });
        it("passes an ErrorResult to callbacks", () => {
            f.must(r => log(isError(r) && r.err));
            f.throw("pow");
            see("pow");
        });
    });
    describe(".return()", () => {
        it("Fails on an already ended job", () => {
            f.end();
            expect(() => f.return(42)).to.throw("Job already ended");
            f = makeJob(); f.return(99);
            expect(() => f.return(42)).to.throw("Job already ended");
            f = makeJob(); f.throw("blah");
            expect(() => f.return(42)).to.throw("Job already ended");
        });
        it("passes a ValueResult to callbacks", () => {
            f.must(r => log(isValue(r) && r.val));
            f.return(42);
            see("42");
        });
    });
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
        it("makes the job active", () => {
            var active: Job;
            expect(isJobActive()).to.be.false;
            f.run(() => { active = getJob(); });
            expect(active).to.equal(f);
            expect(isJobActive()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = makeJob();
            expect(isJobActive()).to.be.false;
            f.run(() => {
                expect(getJob()).to.equal(f);
                f1.run(() => expect(getJob()).to.equal(f1));
                try {
                    f1.run(() => { throw new Error; });
                } catch (e) {
                    expect(getJob()).to.equal(f);
                }
            });
            expect(isJobActive()).to.be.false;
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
    describe(".bind() returns a function that", () => {
        it("makes the job active", () => {
            var active: Job;
            expect(isJobActive()).to.be.false;
            f.bind(() => { active = getJob(); })();
            expect(active).to.equal(f);
            expect(isJobActive()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = makeJob();
            expect(isJobActive()).to.be.false;
            f.bind(() => {
                expect(getJob()).to.equal(f);
                f1.bind(() => expect(getJob()).to.equal(f1))();
                try {
                    f1.bind(() => { throw new Error; })();
                } catch (e) {
                    expect(getJob()).to.equal(f);
                }
            })();
            expect(isJobActive()).to.be.false;
        });
        it("passes through arguments and `this`", () => {
            // Given an object to use as `this`
            const ob = {};
            // When a bound function is called with a this and arguments
            const res = f.bind(function (...args) { args.map(log); return this; }).call(ob, 1, 2, 3);
            // Then the function should receive the arguments
            see("1", "2", "3")
            // And return its result
            expect(res).to.equal(ob);
        });

    });

    function jobWithHandlers() {
        return detached.start()
            .onError(e => log(`Err: ${e}`))
            .onValue(v => log(`Val: ${v}`))
            .onCancel(() => log("cancel"))
        ;
    }

    describe("onValue()", () => {
        it("calls the callback with the value upon return", () => {
            // Given a job with a value handler
            const j = jobWithHandlers();
            // When the job is return()ed
            j.return(42);
            // Then it should call the handler with the value
            see("Val: 42");
        });
    });
    describe("onError()", () => {
        it("calls the callback with the error upon throw, marking the error handled", () => {
            // Given a job with an onError-logging handler
            const j = jobWithHandlers();
            // That also logs the handling status before and after the onError handler
            function logHandled(r: JobResult<any>) { log(isHandled(r) ? "handled" : "not handled yet"); }
            j.must(logHandled).do(logHandled)  // must runs before, do runs after
            // When the job is throw()n
            j.throw("boo");
            // Then it should call the handler with the error
            // and mark the error handled
            see("not handled yet", "Err: boo", "handled");
        });
    });
    describe("onCancel()", () => {
        it("calls the callback after canceling", () => {
            // Given a job with a value handler
            const j = jobWithHandlers();
            // When the job is end()ed
            j.end();
            // Then it should call the handler
            see("cancel");
        });
    });
});

describe("restarting()", () => {
    it("runs functions in call-specific, restarting jobs, until enclosing job ends", () => {
        // Given a restarting wrapper created in an outer job
        const outer = makeJob(), w = outer.bind(restarting)();
        let f1: Job, f2: Job;
        // When it's called with a function
        w(() => { f1 = getJob(); log("called"); must(() => log("undo")); });
        // Then the function should run in a distinct job
        see("called");
        expect(f1).to.be.instanceOf(outer.constructor);
        expect(f1).to.not.equal(outer);
        // And when it's called with another function
        w(() => { f2 = getJob(); log("another"); return () => log("undo 2"); });
        // Then it should run in the same job after restarting
        expect(f1).to.equal(f2);
        see("undo", "another");
        // And if the outer job ends, so should the inner
        outer.end();
        see("undo 2");
        // Following which, it should throw an error if called again:
        expect(() => w(() => log("this won't do"))).to.throw("Job already ended")
    });
    it("uses a different job for each wrapper", () => {
        // Given two restarting wrappers created in an outer job
        const outer = makeJob(), w1 = outer.bind(restarting)(), w2 = outer.bind(restarting)();
        let f1: Job, f2: Job;
        // When they are called
        w1(() => { f1 = getJob(); });
        w2(() => { f2 = getJob(); });
        // Then the functions should run in two different jobs
        expect(f1).to.be.instanceOf(outer.constructor);
        expect(f2).to.be.instanceOf(outer.constructor);
        expect(f1).to.not.equal(outer);
        expect(f1).to.not.equal(f2);
    });
    it("when given a function, matches its signature", () => {
        // Given a restarting wrapper around a function
        const outer = makeJob(), w = outer.bind(restarting)((a,b,c) => { log(a); log(b); log(c); return 42; });
        // When it is called
        const res = w("a", 22, 54);
        // Then it should receive any arguments
        see("a", "22", "54");
        // And return the result
        expect(res).to.equal(42);
    });
    it("rolls back when an error is thrown", () => {
        // Given a restarting wrapper around a function that throws
        const outer = makeJob(), w = outer.bind(restarting)(() => { must(()=> log("undo")); throw "whoops"; });
        // When the function is called, it should throw
        expect(w).to.throw("whoops");
        // And Then it should end the job
        see("undo");
        expect(isJobActive()).to.be.false;
        expect(w).to.throw("Job already ended");
    });
    it("can be used as a method", () => {
        // Given a restarting-wrapped method
        const w = {m: makeJob().bind(restarting)(function () { log(this === w); })};
        // When called as a method
        w.m();
        // Then its `this` should be the object
        see("true")
    });
});

function msg(val: any) { return () => log(val); }

describe("Cleanup order", () => {
    function setupJobs() {
        const jobs = [] as Job<any>[];
        jobs.unshift(detached.start(j => {
            log("starting @ root");
            must(msg("must @ root"));
            j.release(msg("release @ root"));
            for (const i of [1, 2, 3]) jobs.push(start(j => {
                log(`starting @ sub ${i}`);
                must(msg(`must @ sub ${i}`));
                j.release(msg(`release @ sub ${i}`));
            }).do(msg(`do @ sub ${i}`)));
        }).do(msg("do @ root")));
        see("starting @ root", "starting @ sub 1", "starting @ sub 2", "starting @ sub 3");
        return jobs;
    }

    it("runs all child release()s before *any* must()s or do()s", () => {
        // Given some nested jobs
        const [j] = setupJobs();
        // When the root job is ended
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

    it("runs restart() cleanups to completion before resuming other cleanups", () => {
        // Given some nested jobs, with a job that's restarted by one of them in a cleanup
        const [j, _j1, j2, _j3] = setupJobs();
        const toRestart = detached.start(() => {
            must(msg("must @ restart"));
            start(() => msg("must @ restart sub"));
        })
        j2.must(() => { log("restart begins"); toRestart.restart(); log("restart done"); })
        // When the root is ended
        j.end()
        // Then the restart should run its own full cleanup tree
        // before resuming the enclosing one
        see(
            "release @ sub 3", "release @ sub 2", "release @ sub 1", "release @ root",
            "must @ sub 3", "do @ sub 3",

            "restart begins",
            "must @ restart sub",
            "must @ restart",
            "restart done",

            "must @ sub 2", "do @ sub 2",
            "must @ sub 1", "do @ sub 1",
            "must @ root",  "do @ root"
        )
    });
});
