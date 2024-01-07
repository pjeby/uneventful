import { afterEach, beforeEach, clock, describe, expect, it, log, see, spy, useClock, useRoot } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, Flow, start, isFlowActive, must, root, release, detached, makeFlow } from "../mod.ts";

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
        describe("won't revive an ended flow", () => {
            it("after the end()", () => {
                // Given an ended flow
                const r = makeFlow(); r.end();
                // When restart is called
                // Then it should throw
                expect(() => r.restart()).to.throw("Can't restart ended flow")
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
                see("Error: Can't restart ended flow");
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
        const flow = root(() => {
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
                log(flow === current.flow); d = destroy; must(() => log("destroy"))
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

describe("root(action)", () => {
    it("runs with a new flow active, passing in a destroy and the flow", () => {
        var d: () => void;
        const flow = root((destroy, flow) => {
            log(flow === current.flow); d = destroy; must(() => log("destroy"))
        });
        expect(d).to.equal(flow.end);
        see("true"); flow.end(); see("destroy");
    });
    it("adds the return value if it's a function", () => {
        const cb = spy();
        const flow = root(() => cb as CleanupFn);
        expect(cb).to.not.have.been.called;
        flow.end();
        expect(cb).to.have.been.calledOnce;
    });
    it("cleans up on throw", () => {
        var cb = spy();
        expect(() => root(() => {
            must(cb);
            expect(cb).to.not.have.been.called;
            throw new Error("dang");
        })).to.throw("dang");
        expect(cb).to.have.been.calledOnce;
    });
});

describe("detached(factory)", () => {
    it("throws in response to must()", () => {
        // Given a detached flow factory that uses must()
        const d = detached(() => {
            must(() => log("cleanup"));
        })
        // When it's invoked Then it should throw an error
        expect(d).to.throw("Can't add cleanups in a detached flow");
    });
    it("allows creating 'nested' flows", () => {
        // Given a detached flow factory that creates a flow
        const flow = detached(() => start(() => {
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
            expect(must(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
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
        it("must()", () => { expect(() => must(() => {})).to.throw(msg); });
        it("release()", () => { expect(() => release(() => {})).to.throw(msg); });
    });
});

describe("Flow instances", () => {
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
    describe(".end()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            f.must(c1); f.must(c2); f.must(c3);
            f.end();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks under the job they were added with", () => {
            const job1: any = {}, job2: any = {}, job3: any = {}, old = swapCtx(makeCtx());
            try {
                current.job = job1; f.must(() => expect(current.job).to.equal(job1));
                current.job = job2; f.must(() => expect(current.job).to.equal(job2));
                current.job = job3;
                f.end();
                expect(current.job).to.equal(job3);
            } finally { swapCtx(old); }
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
        it("makes the flow active", () => {
            var active: Flow;
            expect(current.flow).to.be.undefined;
            f.run(() => { active = current.flow; });
            expect(active).to.equal(f);
            expect(current.flow).to.be.undefined;
        });
        it("restores the context, even on error", () => {
            const f1 = makeFlow();
            expect(current.flow).to.be.undefined;
            f.run(() => {
                expect(current.flow).to.equal(f);
                f1.run(() => expect(current.flow).to.equal(f1));
                try {
                    f1.run(() => { throw new Error; });
                } catch (e) {
                    expect(current.flow).to.equal(f);
                }
            });
            expect(current.flow).to.be.undefined;
        });
    });
});
