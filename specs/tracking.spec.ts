import { afterEach, beforeEach, describe, expect, it, log, see, spy, useRoot } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, Flow, flow, isFlowActive, onEnd, root, linkedEnd, detached, runner, Runner } from "../mod.ts";

describe("runner()", () => {
    it("returns new standalone runners", () => {
        const flow1 = runner(), flow2 = runner();
        expect(flow1.end).to.be.a("function");
        expect(flow2.end).to.be.a("function");
        expect(flow1).to.not.equal(flow2);
    });
    describe("creates nested flows,", () => {
        var r: Runner, f: Flow, cb = spy();
        beforeEach(() => { cb = spy(); r = runner(); f = r.flow; });
        it("calling the stop function if outer is cleaned up", () => {
            runner(f, cb);
            expect(cb).to.not.have.been.called;
            r.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("not calling the stop function if inner is cleaned up", () => {
            const inner = runner(f, cb);
            expect(cb).to.not.have.been.called;
            inner.end();
            r.end();
            expect(cb).to.not.have.been.called;
        });
        it("cleaning up the inner as the default stop action", () => {
            const inner = runner(f);
            inner.flow.onEnd(cb);
            expect(cb).to.not.have.been.called;
            r.end();
            expect(cb).to.have.been.calledOnce;
        });
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
            const dispose = flow((destroy) => { d = destroy; onEnd(() => log("destroy")) });
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
            const d1 = flow(() => { onEnd(() => log("destroy")) });
            d1(); see("destroy");
            const d2 = flow(() => { onEnd(() => log("destroy")) });
            d1(); see();
            d2(); see("destroy");
        });
    });
});

describe("root(action)", () => {
    it("runs with a new flow active, passing in a destroy", () => {
        var d: () => void;
        const dispose = root((destroy) => { d = destroy; onEnd(() => log("destroy")) });
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
        const d1 = root(() => { onEnd(() => log("destroy")) });
        d1(); see("destroy");
        const d2 = root(() => { onEnd(() => log("destroy")) });
        d1(); see();
        d2(); see("destroy");
    });
});

describe("detached(factory)", () => {
    it("throws in response to onEnd()", () => {
        // Given a detached flow factory that uses onEnd
        const d = detached(() => {
            onEnd(() => log("cleanup"));
        })
        // When it's invoked Then it should throw an error
        expect(d).to.throw("Can't add cleanups in a detached flow");
    });
    it("allows creating 'nested' flows", () => {
        // Given a detached flow factory that creates a flow
        const cleanup = detached(() => flow(() => {
            onEnd(() => log("cleanup"));
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
        runner().flow.run(()=> {
            expect(isFlowActive(), "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(isFlowActive(), "Shouldn't be active after run()").to.be.false;
    });
    describe("calls methods on the active flow", () => {
        var t1: Flow, cb = spy();
        beforeEach(() => { t1 = runner().flow; cb = spy(); current.flow = t1; });
        afterEach(() => { current.flow = undefined; });
        it("onEnd", () => {
            const m = spy(t1, "onEnd");
            expect(onEnd(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        })
        it("linkedEnd()", () => {
            const m = spy(t1, "linkedEnd");
            const unlink = linkedEnd(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
    });
    describe("throws when there's no active flow", () => {
        const msg = "No flow is currently active";
        it("onEnd()", () => { expect(() => onEnd(() => {})).to.throw(msg); });
        it("linkedEnd()", () => { expect(() => linkedEnd(() => {})).to.throw(msg); });
    });
});

describe("Flow instances", () => {
    var r: Runner, f: Flow;
    beforeEach(() => { r = runner(); f = r.flow; });
    describe(".onEnd()", () => {
        it("can be called without a callback", () => {
            f.onEnd(); r.end();
        });
        it("calls the callback if given one", () => {
            const cb = spy();
            f.onEnd(cb);
            expect(cb).to.not.have.been.called;
            r.end();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".cleanup()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            f.onEnd(c1); f.onEnd(c2); f.onEnd(c3);
            r.end();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks under the job they were added with", () => {
            const job1: any = {}, job2: any = {}, job3: any = {}, old = swapCtx(makeCtx());
            try {
                current.job = job1; f.onEnd(() => expect(current.job).to.equal(job1));
                current.job = job2; f.onEnd(() => expect(current.job).to.equal(job2));
                current.job = job3;
                r.end();
                expect(current.job).to.equal(job3);
            } finally { swapCtx(old); }
        });
        it("converts errors to unhandled rejections", async () => {
            const cb1 = spy(), cb2 = spy();
            f.onEnd(cb1);
            f.onEnd(() => { throw new Error("caught me!"); })
            f.onEnd(cb2);
            r.end();
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
    describe(".linkedEnd()", () => {
        it("calls the callback on cleanup", () => {
            const cb = spy();
            f.linkedEnd(cb);
            expect(cb).to.not.have.been.called;
            r.end();
            expect(cb).to.have.been.calledOnce;
        });
        it("can be cancelled", () => {
            const cb = spy();
            const cancel = f.linkedEnd(cb);
            expect(cb).to.not.have.been.called;
            cancel();
            r.end();
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
            const f1 = runner().flow;
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
            f.onEnd(cb);
            expect(() => f.run(() => {
                expect(cb).to.not.have.been.called;
                throw new Error("dang");
            })).to.throw("dang");
            expect(cb).to.have.been.calledOnce;
        });
    });
});
