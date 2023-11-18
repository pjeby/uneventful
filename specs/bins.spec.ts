import { afterEach, beforeEach, describe, expect, it, spy } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { Cleanup, DisposalBin, bin, cleanup } from "../mod.ts";

describe("bin", () => {
    it(".active is true during run()", () => {
        var tested: boolean;
        expect(bin.active, "Shouldn't be active before run()").to.be.false;
        bin().run(()=> {
            expect(bin.active, "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(bin.active, "Shouldn't be active after run()").to.be.false;
    })
    describe("bin()", () => {
        it("returns new bins", () => {
            const bin1 = bin(), bin2 = bin();
            expect(bin1).to.be.instanceof(bin);
            expect(bin2).to.be.instanceof(bin);
            expect(bin1).to.not.equal(bin2);
        });
        it("recycles destroyed bins", () => {
            const bin1 = bin();
            bin1.destroy();
            const bin2 = bin();
            expect(bin2, "should be recycled").to.equal(bin1);
        });
        describe("when given a callback", () => {
            it("runs it with the bin active, passing in a destroy", () => {
                var active: DisposalBin, d: () => void;
                const b = bin((destroy) => { d = destroy; active = current.bin; });
                expect(active.destroy).to.equal(b);
                expect(d).to.equal(b);
            });
            it("adds the return value if it's a function", () => {
                const cb = spy();
                const b = bin(() => cb as Cleanup);
                expect(cb).to.not.have.been.called;
                b();
                expect(cb).to.have.been.calledOnce;
            });
        })
    });
    describe("calls methods on the active bin", () => {
        var bin1 = bin(), cb = spy();
        beforeEach(() => { bin1 = bin(); cb = spy(); current.bin = bin1; });
        afterEach(() => { current.bin = undefined; });
        it("cleanup", () => {
            const m = spy(bin1, "add");
            expect(cleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        })
        it(".add()", () => {
            const m = spy(bin1, "add");
            expect(bin.add(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        });
        it(".addlink()", () => {
            const m = spy(bin1, "addLink");
            const unlink = bin.addLink(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
        it(".link()", () => {
            const m = spy(bin1, "link");
            const bin2 = bin();
            bin.link(bin2, cb);
            expect(m).to.have.been.calledOnceWithExactly(bin2, cb).and.returned(bin2);
        });
        it(".nested()", () => {
            const m = spy(bin1, "nested");
            const bin2 = bin.nested(cb);
            expect(m).to.have.been.calledOnceWithExactly(cb);
            expect(bin2).to.be.instanceOf(bin);
        });
    });
    describe("throws when there's no active bin", () => {
        const msg = "No disposal bin is currently active";
        it("cleanup()", () => { expect(() => cleanup(() => {})).to.throw(msg); });
        it(".add()", () => { expect(() => bin.add(() => {})).to.throw(msg); });
        it(".addlink()", () => { expect(() => bin.addLink(() => {})).to.throw(msg); });
        it(".link()", () => { expect(() => bin.link(bin(), () => {})).to.throw(msg); });
        it(".nested", () => { expect(() => bin.nested(() => {})).to.throw(msg); });
    })
});

describe("bin instances", () => {
    var b: DisposalBin;
    beforeEach(() => { b = bin(); });
    describe(".add()", () => {
        it("can be called without a callback", () => {
            b.add(); b.cleanup();
        });
        it("calls the callback if given one", () => {
            const cb = spy();
            b.add(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".cleanup()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            b.add(c1); b.add(c2); b.add(c3);
            b.cleanup();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks under the job they were added with", () => {
            const job1: any = {}, job2: any = {}, job3: any = {}, old = swapCtx(makeCtx());
            try {
                current.job = job1; b.add(() => expect(current.job).to.equal(job1));
                current.job = job2; b.add(() => expect(current.job).to.equal(job2));
                current.job = job3;
                b.cleanup();
                expect(current.job).to.equal(job3);
            } finally { swapCtx(old); }
        });
        it("converts errors to unhandled rejections", async () => {
            const cb1 = spy(), cb2 = spy();
            b.add(cb1);
            b.add(() => { throw new Error("caught me!"); })
            b.add(cb2);
            b.cleanup();
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
    it(".destroy() cleans up the bin", () => {
        const cb = spy();
        b.add(cb);
        expect(cb).to.not.have.been.called;
        b.destroy();
        expect(cb).to.have.been.calledOnce;
    });
    describe("addLink()", () => {
        it("calls the callback on cleanup", () => {
            const cb = spy();
            b.addLink(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("can be canceled", () => {
            const cb = spy();
            const cancel = b.addLink(cb);
            expect(cb).to.not.have.been.called;
            cancel();
            b.cleanup();
            expect(cb).to.not.have.been.called;
        });
    });
    describe("nested()", () => {
        var cb = spy();
        beforeEach(() => { cb = spy(); });
        it("calls the stop function if outer is cleaned up", () => {
            b.nested(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't call the stop function if inner is cleaned up", () => {
            const inner = b.nested(cb);
            expect(cb).to.not.have.been.called;
            inner.cleanup();
            b.cleanup();
            expect(cb).to.not.have.been.called;
        });
        it("cleans up the inner as the default stop action", () => {
            const inner = b.nested();
            inner.add(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe("link()", () => {
        var cb = spy(), inner = bin();
        beforeEach(() => {
            cb = spy();
            inner = bin();
        });
        it("calls the stop function if outer is cleaned up", () => {
            b.link(inner, cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't call the stop function if inner is cleaned up", () => {
            b.link(inner, cb);
            expect(cb).to.not.have.been.called;
            inner.cleanup();
            b.cleanup();
            expect(cb).to.not.have.been.called;
        });
        it("cleans up the inner as the default stop action", () => {
            b.link(inner);
            inner.add(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".run()", () => {
        it("makes the bin active", () => {
            var active: DisposalBin;
            expect(current.bin).to.be.undefined;
            b.run(() => { active = current.bin; });
            expect(active).to.equal(b);
            expect(current.bin).to.be.undefined;
        });
        it("restores the context, even on error", () => {
            const b1 = bin();
            expect(current.bin).to.be.undefined;
            b.run(() => {
                expect(current.bin).to.equal(b);
                b1.run(() => expect(current.bin).to.equal(b1));
                try {
                    b1.run(() => { throw new Error; });
                } catch (e) {
                    expect(current.bin).to.equal(b);
                }
            });
            expect(current.bin).to.be.undefined;
        });
        it("cleans up on throw", () => {
            var cb = spy();
            b.add(cb);
            expect(() => b.run(() => {
                expect(cb).to.not.have.been.called;
                throw new Error("dang");
            })).to.throw("dang");
            expect(cb).to.have.been.calledOnce;
        });
    });
});
