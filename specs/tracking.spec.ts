import { afterEach, beforeEach, describe, expect, it, log, see, spy } from "./dev_deps.ts";
import { current, makeCtx, swapCtx } from "../src/ambient.ts";
import { CleanupFn, ResourceTracker, tracker, onCleanup, track } from "../mod.ts";

describe("tracker", () => {
    it(".active() is true during run()", () => {
        var tested: boolean;
        expect(tracker.active(), "Shouldn't be active before run()").to.be.false;
        tracker().run(()=> {
            expect(tracker.active(), "Should be active during run()").to.be.true;
            tested = true;
        })
        expect(tested, "Should have called the run function").to.be.true;
        expect(tracker.active(), "Shouldn't be active after run()").to.be.false;
    })
    describe("tracker()", () => {
        it("returns new trackers", () => {
            const tracker1 = tracker(), tracker2 = tracker();
            expect(tracker1).to.be.instanceof(tracker);
            expect(tracker2).to.be.instanceof(tracker);
            expect(tracker1).to.not.equal(tracker2);
        });
        it("recycles destroyed trackers", () => {
            const tracker1 = tracker();
            tracker1.destroy();
            const tracker2 = tracker();
            expect(tracker2, "should be recycled").to.equal(tracker1);
        });
    });
    describe("track()", () => {
        it("runs with a new tracker active, passing in a destroy", () => {
            var d: () => void;
            const dispose = track((destroy) => { d = destroy; onCleanup(() => log("destroy")) });
            expect(d).to.equal(dispose);
            see(); dispose(); see("destroy");
        });
        it("adds the return value if it's a function", () => {
            const cb = spy();
            const b = track(() => cb as CleanupFn);
            expect(cb).to.not.have.been.called;
            b();
            expect(cb).to.have.been.calledOnce;
        });
        it("doesn't destroy recycled trackers", () => {
            const d1 = track(() => { onCleanup(() => log("destroy")) });
            d1(); see("destroy");
            const d2 = track(() => { onCleanup(() => log("destroy")) });
            d1(); see();
            d2(); see("destroy");
        })
    })
    describe("calls methods on the active tracker", () => {
        var t1 = tracker(), cb = spy();
        beforeEach(() => { t1 = tracker(); cb = spy(); current.tracker = t1; });
        afterEach(() => { current.tracker = undefined; });
        it("cleanup", () => {
            const m = spy(t1, "onCleanup");
            expect(onCleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        })
        it(".onCleanup()", () => {
            const m = spy(t1, "onCleanup");
            expect(tracker.onCleanup(cb)).to.be.undefined;
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(undefined);
        });
        it(".addlink()", () => {
            const m = spy(t1, "addLink");
            const unlink = tracker.addLink(cb);
            expect(unlink).to.be.a("function");
            expect(m).to.have.been.calledOnceWithExactly(cb).and.returned(unlink);
        });
        it(".link()", () => {
            const m = spy(t1, "link");
            const t2 = tracker();
            tracker.link(t2, cb);
            expect(m).to.have.been.calledOnceWithExactly(t2, cb).and.returned(t2);
        });
        it(".nested()", () => {
            const m = spy(t1, "nested");
            const t2 = tracker.nested(cb);
            expect(m).to.have.been.calledOnceWithExactly(cb);
            expect(t2).to.be.instanceOf(tracker);
        });
    });
    describe("throws when there's no active tracker", () => {
        const msg = "No resource tracker is currently active";
        it("onCleanup()", () => { expect(() => onCleanup(() => {})).to.throw(msg); });
        it(".onCleanup()", () => { expect(() => tracker.onCleanup(() => {})).to.throw(msg); });
        it(".addlink()", () => { expect(() => tracker.addLink(() => {})).to.throw(msg); });
        it(".link()", () => { expect(() => tracker.link(tracker(), () => {})).to.throw(msg); });
        it(".nested", () => { expect(() => tracker.nested(() => {})).to.throw(msg); });
    })
});

describe("tracker instances", () => {
    var b: ResourceTracker;
    beforeEach(() => { b = tracker(); });
    describe(".add()", () => {
        it("can be called without a callback", () => {
            b.onCleanup(); b.cleanup();
        });
        it("calls the callback if given one", () => {
            const cb = spy();
            b.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".cleanup()", () => {
        it("runs callbacks in reverse order", () => {
            const c1 = spy(), c2 = spy(), c3 = spy();
            b.onCleanup(c1); b.onCleanup(c2); b.onCleanup(c3);
            b.cleanup();
            expect(c3).to.have.been.calledImmediatelyBefore(c2);
            expect(c2).to.have.been.calledImmediatelyBefore(c1);
            expect(c1).to.have.been.calledOnce
        });
        it("runs callbacks under the job they were added with", () => {
            const job1: any = {}, job2: any = {}, job3: any = {}, old = swapCtx(makeCtx());
            try {
                current.job = job1; b.onCleanup(() => expect(current.job).to.equal(job1));
                current.job = job2; b.onCleanup(() => expect(current.job).to.equal(job2));
                current.job = job3;
                b.cleanup();
                expect(current.job).to.equal(job3);
            } finally { swapCtx(old); }
        });
        it("converts errors to unhandled rejections", async () => {
            const cb1 = spy(), cb2 = spy();
            b.onCleanup(cb1);
            b.onCleanup(() => { throw new Error("caught me!"); })
            b.onCleanup(cb2);
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
    it(".destroy() cleans up the tracker", () => {
        const cb = spy();
        b.onCleanup(cb);
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
            inner.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe("link()", () => {
        var cb = spy(), inner = tracker();
        beforeEach(() => {
            cb = spy();
            inner = tracker();
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
            inner.onCleanup(cb);
            expect(cb).to.not.have.been.called;
            b.cleanup();
            expect(cb).to.have.been.calledOnce;
        });
    });
    describe(".run()", () => {
        it("makes the tracker active", () => {
            var active: ResourceTracker;
            expect(current.tracker).to.be.undefined;
            b.run(() => { active = current.tracker; });
            expect(active).to.equal(b);
            expect(current.tracker).to.be.undefined;
        });
        it("restores the context, even on error", () => {
            const b1 = tracker();
            expect(current.tracker).to.be.undefined;
            b.run(() => {
                expect(current.tracker).to.equal(b);
                b1.run(() => expect(current.tracker).to.equal(b1));
                try {
                    b1.run(() => { throw new Error; });
                } catch (e) {
                    expect(current.tracker).to.equal(b);
                }
            });
            expect(current.tracker).to.be.undefined;
        });
        it("cleans up on throw", () => {
            var cb = spy();
            b.onCleanup(cb);
            expect(() => b.run(() => {
                expect(cb).to.not.have.been.called;
                throw new Error("dang");
            })).to.throw("dang");
            expect(cb).to.have.been.calledOnce;
        });
    });
});
