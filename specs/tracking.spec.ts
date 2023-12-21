import { afterEach, beforeEach, describe, expect, it, log, see, spy, useRoot } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, Flow, flow, isFlowActive, onCleanup, root, linkedCleanup, makeFlow, detached } from "../mod.ts";

describe("makeFlow()", () => {
    it("returns new standalone flows", () => {
        const flow1 = makeFlow(), flow2 = makeFlow();
        expect(flow1).to.be.instanceof(Flow);
        expect(flow2).to.be.instanceof(Flow);
        expect(flow1).to.not.equal(flow2);
    });
    it("recycles destroyed flows", () => {
        const flow1 = makeFlow();
        flow1.destroy();
        const flow2 = makeFlow();
        expect(flow2, "should be recycled").to.equal(flow1);
    });
});

describe("flow(action)", () => {
    it("doesn't run without an enclosing flow", () => {
        expect(() => flow(()=>{})).to.throw("No flow is currently active");
    });
    it("links to the enclosing flow", () => {
        // Given a flow created within a standalone flow
        const dispose = root(() => {
            flow(() => () => log("cleanup"))
        });
        see();
        // When the outer flow is disposed
        dispose();
        // Then the inner flow should be cleaned up
        see("cleanup");
    });
    describe("with an enclosing flow", () => {
        useRoot();
        it("runs with a new flow active, passing in a destroy", () => {
            var d: () => void;
            const dispose = flow((destroy) => { d = destroy; onCleanup(() => log("destroy")) });
            expect(d).to.equal(dispose);
            see(); dispose(); see("destroy");
        });
        it("adds the return value if it's a function", () => {
            const cb = spy();
            const dispose = flow(() => cb as CleanupFn);
            expect(cb).to.not.have.been.called;
            dispose();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't destroy recycled flows", () => {
            const d1 = flow(() => { onCleanup(() => log("destroy")) });
            d1(); see("destroy");
            const d2 = flow(() => { onCleanup(() => log("destroy")) });
            d1(); see();
            d2(); see("destroy");
        });
    });
});

describe("root(action)", () => {
    it("runs with a new flow active, passing in a destroy", () => {
        var d: () => void;
        const dispose = root((destroy) => { d = destroy; onCleanup(() => log("destroy")) });
        expect(d).to.equal(dispose);
        see(); dispose(); see("destroy");
    });
    it("adds the return value if it's a function", () => {
        const cb = spy();
        const dispose = root(() => cb as CleanupFn);
        expect(cb).to.not.have.been.called;
        dispose();
        expect(cb).to.have.been.calledOnce;
    });
    it("doesn't destroy recycled flows", () => {
        const d1 = root(() => { onCleanup(() => log("destroy")) });
        d1(); see("destroy");
        const d2 = root(() => { onCleanup(() => log("destroy")) });
        d1(); see();
        d2(); see("destroy");
    });
});

describe("detached(factory)", () => {
    it("throws in response to onCleanup()", () => {
        // Given a detached flow factory that uses onCleanup
        const d = detached(() => {
            onCleanup(() => log("cleanup"));
        })
        // When it's invoked Then it should throw an error
        expect(d).to.throw("Can't add cleanups in a detached flow");
    });
    it("allows creating 'nested' flows", () => {
        // Given a detached flow factory that creates a flow
        const cleanup = detached(() => flow(() => {
            onCleanup(() => log("cleanup"));
        }))();
        see();
        // When the flow's cleanup is called
        cleanup();
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
        var t1 = makeFlow(), cb = spy();
        beforeEach(() => { t1 = makeFlow(); cb = spy(); current.flow = t1; });
        afterEach(() => { current.flow = undefined; });
        it("onCleanup", () => {
            const m = spy(t1, "onCleanup");
            expect(onCleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        })
        it("linkedCleanup()", () => {
            const m = spy(t1, "linkedCleanup");
            const unlink = linkedCleanup(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
    });
    describe("throws when there's no active flow", () => {
        const msg = "No flow is currently active";
        it("onCleanup()", () => { expect(() => onCleanup(() => {})).to.throw(msg); });
        it("linkedCleanup()", () => { expect(() => linkedCleanup(() => {})).to.throw(msg); });
    });
});

describe("Flow instances", () => {
    var f: Flow;
    beforeEach(() => { f = makeFlow(); });
    describe(".onCleanup()", () => {
        it("can be called without a callback", () => {
            f.onCleanup(); f.cleanup();
        });
        it("calls the callback if given one", () => {
            const cb = spy();
            f.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".cleanup()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            f.onCleanup(c1); f.onCleanup(c2); f.onCleanup(c3);
            f.cleanup();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks under the job they were added with", () => {
            const job1: any = {}, job2: any = {}, job3: any = {}, old = swapCtx(makeCtx());
            try {
                current.job = job1; f.onCleanup(() => expect(current.job).to.equal(job1));
                current.job = job2; f.onCleanup(() => expect(current.job).to.equal(job2));
                current.job = job3;
                f.cleanup();
                expect(current.job).to.equal(job3);
            } finally { swapCtx(old); }
        });
        it("converts errors to unhandled rejections", async () => {
            const cb1 = spy(), cb2 = spy();
            f.onCleanup(cb1);
            f.onCleanup(() => { throw new Error("caught me!"); })
            f.onCleanup(cb2);
            f.cleanup();
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
    it(".destroy() cleans up the flow", () => {
        const cb = spy();
        f.onCleanup(cb);
        expect(cb).to.not.have.been.called;
        f.destroy();
        expect(cb).to.have.been.calledOnce;
    });
    describe(".linkedCleanup()", () => {
        it("calls the callback on cleanup", () => {
            const cb = spy();
            f.linkedCleanup(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("can be cancelled", () => {
            const cb = spy();
            const cancel = f.linkedCleanup(cb);
            expect(cb).to.not.have.been.called;
            cancel();
            f.cleanup();
            expect(cb).to.not.have.been.called;
        });
    });
    describe("makeFlow() nested", () => {
        var cb = spy();
        beforeEach(() => { cb = spy(); });
        it("calls the stop function if outer is cleaned up", () => {
            makeFlow(f, cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't call the stop function if inner is cleaned up", () => {
            const inner = makeFlow(f, cb);
            expect(cb).to.not.have.been.called;
            inner.cleanup();
            f.cleanup();
            expect(cb).to.not.have.been.called;
        });
        it("cleans up the inner as the default stop action", () => {
            const inner = makeFlow(f);
            inner.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
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
        it("cleans up on throw", () => {
            var cb = spy();
            f.onCleanup(cb);
            expect(() => f.run(() => {
                expect(cb).to.not.have.been.called;
                throw new Error("dang");
            })).to.throw("dang");
            expect(cb).to.have.been.calledOnce;
        });
    });
});
