import { afterEach, beforeEach, clock, describe, expect, it, log, see, spy, useClock, useRoot } from "./dev_deps.ts";
import { current, freeCtx, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, Flow, start, isFlowActive, must, release, detached, makeFlow, getFlow, isCancel, isError, isValue } from "../mod.ts";
import { Cell } from "../src/cells.ts";

describe("makeFlow()", () => {
    it("returns new standalone flows", () => {
        const flow1 = makeFlow(), flow2 = makeFlow();
        expect(flow1.end).to.be.a("function");
        expect(flow2.end).to.be.a("function");
        expect(flow1).to.not.equal(flow2);
    });
    describe(".restart() ", () => {
        useClock();
        it("doesn't permanently terminate the flow", () => {
            // Given a restarted flow
            const f = makeFlow(); f.restart();
            // When new cleanups are added to the flow
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they don't run until the next restart
            clock.runAll(); see();
            f.restart(); see("release()", "must()");
            // Or next end
            f.release(() => log("release()2"));
            f.must(() => log("must()2"));
            clock.runAll(); see();
            f.end(); see("must()2", "release()2");
        });
        it("passes CancelResult to cleanups", () => {
            const f = makeFlow();
            f.must(r => log(isCancel(r)));
            f.restart();
            see("true");
        });
        describe("won't revive an ended flow", () => {
            it("after the end()", () => {
                // Given an ended flow
                const r = makeFlow(); r.end();
                // When restart is called
                // Then it should throw
                expect(() => r.restart()).to.throw("Flow already ended")
            });
            it("during the end()", () => {
                // Given a flow with a callback that runs restart
                const f = makeFlow();
                f.must(() => {
                    try { f.restart(); } catch(e) { log(e); }
                })
                // When the flow is ended
                f.end();
                // Then the restart attempt should throw
                see("Error: Flow already ended");
            });
        });
    });
    describe(".end() makes future cleanups run async+asap", () => {
        useClock();
        it("makes future must() + un-canceled release() run async+asap", () => {
            // Given an ended flow with some cleanups
            const f = makeFlow(); f.end();
            // When new cleanups are added to the flow
            f.must(() => log("must()"));
            f.release(() => log("release()"));
            // Then they run asynchronously
            clock.tick(0); see("release()", "must()");
        });
        it("doesn't run canceled release()", () => {
            // Given an ended flow with a cleanup
            const f = makeFlow(); f.end();
            f.must(() => log("this should still run"));
            // When a release() is added and canceled
            f.release(() => log("this won't"))();
            // Then it should not be called, even though the
            // first cleanup is
            clock.tick(0); see("this should still run");
        });
    });
    describe("creates nested flows,", () => {
        var f: Flow, cb = spy();
        beforeEach(() => { cb = spy(); f = makeFlow(); });
        it("calling the stop function if outer is cleaned up", () => {
            makeFlow(f, cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("not calling the stop function if inner is cleaned up", () => {
            const inner = makeFlow(f, cb);
            expect(cb).to.not.have.been.called;
            inner.end();
            f.end();
            expect(cb).to.not.have.been.called;
        });
        it("cleaning up the inner as the default stop action", () => {
            const inner = makeFlow(f);
            inner.must(cb);
            expect(cb).to.not.have.been.called;
            f.end();
            expect(cb).to.have.been.calledOnce;
        });
    });
});

describe("start(action)", () => {
    it("doesn't run without an enclosing flow", () => {
        expect(() => start(()=>{})).to.throw("No flow is currently active");
    });
    it("links to the enclosing flow", () => {
        // Given a flow created within a standalone flow
        const flow = detached.start(() => {
            start(() => () => log("cleanup"))
        });
        see();
        // When the outer flow is disposed
        flow.end();
        // Then the inner flow should be cleaned up
        see("cleanup");
    });
    describe("with an enclosing flow", () => {
        useRoot();
        it("runs with a new flow active, passing in a destroy and the flow", () => {
            var d: () => void;
            const flow = start((destroy, flow) => {
                log(flow === getFlow()); d = destroy; must(() => log("destroy"))
            });
            expect(d).to.equal(flow.end);
            see("true"); flow.end(); see("destroy");
        });
        it("adds the return value if it's a function", () => {
            const cb = spy();
            const flow = start(() => cb as CleanupFn);
            expect(cb).to.not.have.been.called;
            flow.end();
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

describe("detached.start(action)", () => {
    it("runs with a new flow active, passing in a destroy and the flow", () => {
        var d: () => void;
        const flow = detached.start((destroy, flow) => {
            log(flow === getFlow()); d = destroy; must(() => log("destroy"))
        });
        expect(d).to.equal(flow.end);
        see("true"); flow.end(); see("destroy");
    });
    it("adds the return value if it's a function", () => {
        const cb = spy();
        const flow = detached.start(() => cb as CleanupFn);
        expect(cb).to.not.have.been.called;
        flow.end();
        expect(cb).to.have.been.calledOnce;
    });
    it("cleans up on throw", () => {
        var cb = spy();
        expect(() => detached.start(() => {
            must(cb);
            expect(cb).to.not.have.been.called;
            throw new Error("dang");
        })).to.throw("dang");
        expect(cb).to.have.been.calledOnce;
    });
});

describe("detached.bind(factory)", () => {
    it("throws in response to must()", () => {
        // Given a detached flow factory that uses must()
        const d = detached.bind(() => {
            must(() => log("cleanup"));
        })
        // When it's invoked Then it should throw an error
        expect(d).to.throw("Can't add cleanups to the detached flow");
    });
    it("allows creating 'nested' flows", () => {
        // Given a detached flow factory that creates a flow
        const flow = detached.bind(() => start(() => {
            must(() => log("cleanup"));
        }))();
        see();
        // When the flow's cleanup is called
        flow.end();
        // Then cleanups registered in the flow should run
        see("cleanup");
    });
});

describe("Flow API", () => {
    it("isFlowActive() is true during run()", () => {
        var tested: boolean;
        expect(isFlowActive(), "Shouldn't be active before run()").to.be.false;
        makeFlow().run(()=> {
            expect(isFlowActive(), "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(isFlowActive(), "Shouldn't be active after run()").to.be.false;
    });
    describe("calls methods on the active flow", () => {
        var t1: Flow, cb = spy();
        beforeEach(() => { t1 = makeFlow(); cb = spy(); current.flow = t1; });
        afterEach(() => { current.flow = undefined; });
        it("must()", () => {
            const m = spy(t1, "must");
            expect(must(cb)).to.equal(t1);
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(t1);
        })
        it("release()", () => {
            const m = spy(t1, "release");
            const unlink = release(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
    });
    describe("throws when there's no active flow", () => {
        const msg = "No flow is currently active";
        it("getFlow()", () => { expect(getFlow).to.throw(msg); });
        it("must()", () => { expect(() => must(() => {})).to.throw(msg); });
        it("release()", () => { expect(() => release(() => {})).to.throw(msg); });
    });
});

describe("Flow instances", () => {
    // Given a flow
    var f: Flow;
    beforeEach(() => { f = makeFlow(); });
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
            // Given an ended flow
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
            // Given a thrown flow
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
            // Given a flow with two must callbacks, one of which calls a third
            f
                .must(() => log("first"))
                .must(() => f.must(() => log("last")));
            // When the flow is ended
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
        it("runs callbacks without an active flow or cell", () => {
            let hasFlowOrCell: boolean = undefined;
            f.must(() => hasFlowOrCell = !!(current.flow || current.cell));
            const old = swapCtx(makeCtx(f, {} as Cell));
            try { f.end(); } finally { freeCtx(swapCtx(old)); }
            expect(hasFlowOrCell).to.equal(false);
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
        it("Fails on an already ended flow", () => {
            f.end();
            expect(() => f.throw("boom")).to.throw("Flow already ended");
            f = makeFlow(); f.return(99);
            expect(() => f.throw("boom")).to.throw("Flow already ended");
            f = makeFlow(); f.throw("blah");
            expect(() => f.throw("boom")).to.throw("Flow already ended");
        });
        it("passes an ErrorResult to callbacks", () => {
            f.must(r => log(isError(r) && r.err));
            f.throw("pow");
            see("pow");
        });
    });
    describe(".return()", () => {
        it("Fails on an already ended flow", () => {
            f.end();
            expect(() => f.return(42)).to.throw("Flow already ended");
            f = makeFlow(); f.return(99);
            expect(() => f.return(42)).to.throw("Flow already ended");
            f = makeFlow(); f.throw("blah");
            expect(() => f.return(42)).to.throw("Flow already ended");
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
        it("makes the flow active", () => {
            var active: Flow;
            expect(isFlowActive()).to.be.false;
            f.run(() => { active = getFlow(); });
            expect(active).to.equal(f);
            expect(isFlowActive()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = makeFlow();
            expect(isFlowActive()).to.be.false;
            f.run(() => {
                expect(getFlow()).to.equal(f);
                f1.run(() => expect(getFlow()).to.equal(f1));
                try {
                    f1.run(() => { throw new Error; });
                } catch (e) {
                    expect(getFlow()).to.equal(f);
                }
            });
            expect(isFlowActive()).to.be.false;
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
        it("makes the flow active", () => {
            var active: Flow;
            expect(isFlowActive()).to.be.false;
            f.bind(() => { active = getFlow(); })();
            expect(active).to.equal(f);
            expect(isFlowActive()).to.be.false;
        });
        it("restores the context, even on error", () => {
            const f1 = makeFlow();
            expect(isFlowActive()).to.be.false;
            f.bind(() => {
                expect(getFlow()).to.equal(f);
                f1.bind(() => expect(getFlow()).to.equal(f1))();
                try {
                    f1.bind(() => { throw new Error; })();
                } catch (e) {
                    expect(getFlow()).to.equal(f);
                }
            })();
            expect(isFlowActive()).to.be.false;
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
});
