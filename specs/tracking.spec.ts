import { afterEach, beforeEach, describe, expect, it, log, see, spy, useRoot } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, Flow, flow, onCleanup, root } from "../mod.ts";

describe("flow()", () => {
    it("returns new standalone flows", () => {
        const flow1 = flow(), flow2 = flow();
        expect(flow1).to.be.instanceof(flow);
        expect(flow2).to.be.instanceof(flow);
        expect(flow1).to.not.equal(flow2);
    });
    it("recycles destroyed flows", () => {
        const flow1 = flow();
        flow1.destroy();
        const flow2 = flow();
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


describe("flow", () => {
    it(".active() is true during run()", () => {
        var tested: boolean;
        expect(flow.isActive(), "Shouldn't be active before run()").to.be.false;
        flow().run(()=> {
            expect(flow.isActive(), "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(flow.isActive(), "Shouldn't be active after run()").to.be.false;
    });
    describe("calls methods on the active flow", () => {
        var t1 = flow(), cb = spy();
        beforeEach(() => { t1 = flow(); cb = spy(); current.flow = t1; });
        afterEach(() => { current.flow = undefined; });
        it("cleanup", () => {
            const m = spy(t1, "onCleanup");
            expect(onCleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        })
        it(".onCleanup()", () => {
            const m = spy(t1, "onCleanup");
            expect(flow.onCleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        });
        it(".addlink()", () => {
            const m = spy(t1, "addLink");
            const unlink = flow.addLink(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
        it(".link()", () => {
            const m = spy(t1, "link");
            const t2 = flow();
            flow.link(t2, cb);
            expect(m).to.have.been.calledOnceWithExactly(t2, cb).and.returned(t2);
        });
        it(".nested()", () => {
            const m = spy(t1, "nested");
            const t2 = flow.nested(cb);
            expect(m).to.have.been.calledOnceWithExactly(cb);
            expect(t2).to.be.instanceOf(flow);
        });
    });
    describe("throwing when there's no active flow", () => {
        const msg = "No flow is currently active";
        it("onCleanup()", () => { expect(() => onCleanup(() => {})).to.throw(msg); });
        it(".onCleanup()", () => { expect(() => flow.onCleanup(() => {})).to.throw(msg); });
        it(".addlink()", () => { expect(() => flow.addLink(() => {})).to.throw(msg); });
        it(".link()", () => { expect(() => flow.link(flow(), () => {})).to.throw(msg); });
        it(".nested", () => { expect(() => flow.nested(() => {})).to.throw(msg); });
    });
});

describe("Flow instances", () => {
    var f: Flow;
    beforeEach(() => { f = flow(); });
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
    describe("addLink()", () => {
        it("calls the callback on cleanup", () => {
            const cb = spy();
            f.addLink(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("can be canceled", () => {
            const cb = spy();
            const cancel = f.addLink(cb);
            expect(cb).to.not.have.been.called;
            cancel();
            f.cleanup();
            expect(cb).to.not.have.been.called;
        });
    });
    describe("nested()", () => {
        var cb = spy();
        beforeEach(() => { cb = spy(); });
        it("calls the stop function if outer is cleaned up", () => {
            f.nested(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't call the stop function if inner is cleaned up", () => {
            const inner = f.nested(cb);
            expect(cb).to.not.have.been.called;
            inner.cleanup();
            f.cleanup();
            expect(cb).to.not.have.been.called;
        });
        it("cleans up the inner as the default stop action", () => {
            const inner = f.nested();
            inner.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe("link()", () => {
        var cb = spy(), inner = flow();
        beforeEach(() => {
            cb = spy();
            inner = flow();
        });
        it("calls the stop function if outer is cleaned up", () => {
            f.link(inner, cb);
            expect(cb).to.not.have.been.called;
            f.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't call the stop function if inner is cleaned up", () => {
            f.link(inner, cb);
            expect(cb).to.not.have.been.called;
            inner.cleanup();
            f.cleanup();
            expect(cb).to.not.have.been.called;
        });
        it("cleans up the inner as the default stop action", () => {
            f.link(inner);
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
            const b1 = flow();
            expect(current.flow).to.be.undefined;
            f.run(() => {
                expect(current.flow).to.equal(f);
                b1.run(() => expect(current.flow).to.equal(b1));
                try {
                    b1.run(() => { throw new Error; });
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
