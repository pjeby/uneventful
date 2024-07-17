import { log, see, describe, expect, it, spy } from "./dev_deps.ts";
import { batch, Batch } from "../src/scheduling.ts";

function noop() {}

function runCallbacks(items: Set<() => any>) {
    for (let cb of items) { items.delete(cb); cb(); };
}

describe("Batch", () => {
    describe(".isEmpty()", () => {
        // Given a new Batch
        let q: Batch<any>;
        beforeEach(() => q = batch<any>(noop, noop));
        it("is true by default", () => {
            // When .isEmpty() is called, Then it should be false
            expect(q.isEmpty()).to.be.true;
        });
        it("matches add/remove state", () => {
            // When items are added or removed
            q.add(23);
            // Then .isEmpty() should reflect whether there are items
            expect(q.isEmpty()).to.be.false;
            q.add(44);
            expect(q.isEmpty()).to.be.false;
            q.delete(44);
            expect(q.isEmpty()).to.be.false;
            q.delete(23);
            expect(q.isEmpty()).to.be.true;
        });
    });
    describe(".isRunning()", () => {
        it("reflects whether flush() is running", () => {
            // Given a Batch
            const q: Batch<any> = batch<any>(_ => log(q.isRunning()), noop);
            // When isRunning() is called outside of flush
            // Then it should be false
            expect(q.isRunning()).to.be.false;
            // But When called from the reaping function, it should be true
            q.add(42); q.flush();
            see("true");
        });
    });
    describe(".add()", () => {
        it("calls the scheduling function on transition from empty", () => {
            // Given a Batch that reaps its items
            const sched = spy(), q = batch<any>(q => q.clear(), sched);
            // When an item is added to the scheduler
            q.add(42);
            // Then the scheduling function should be called with a function
            expect(sched).to.have.been.calledOnce;
            // And if another item is added
            q.add(99);
            // Then the spy should not have been called again
            expect(sched).to.have.been.calledOnce;
            // But if the queue is flushed by the scheduler
            sched.args[0][0]();
            // The queue should be empty
            expect(q.isEmpty()).to.be.true;
            // And adding an item again should schedule it again
            q.add(54);
            expect(sched).to.have.been.calledTwice;
        });
        it("won't reschedule itself if it hasn't been called back", () => {
            // Given a scheduler with an item
            const q = batch<any>(q => q.clear(), () => log("scheduled"));
            q.add(42);
            see("scheduled");
            // When the item is removed and another added
            q.delete(42); q.add(99);
            // Then the scheduler should not have been called again
            see();
            // And even after the queue is manually flushed
            q.flush();
            // When an item is added
            q.add(57)
            // Then the scheduler should not be called
            see();
        });
        it("won't reschedule itself if called while flushing", () => {
            // Given a queue that reaps and runs callbacks
            var scheduledFlush: () => unknown;
            const q = batch<() => void>(
                runCallbacks,
                f => { scheduledFlush = f; log("scheduled")}
            );
            // With a callback that adds another callback
            q.add(() => { log("adding"); q.add(() => {}); });
            see("scheduled");
            // When the scheduler is flushed on schedule
            scheduledFlush();
            // Then the callback should be added, but the queue
            // should not schedule itself again
            see("adding");
            see();
        });
    });
    describe(".flush()", () => {
        it("calls the reap function with added items", () => {
            // Given an Batch with some added items
            let items: Set<any>
            const q = batch<any>(q => { items = q; }, noop);
            q.add(52); q.add(47);
            // When flush is called
            q.flush();
            // Then the reaper should be run with a set
            expect(items).to.be.instanceOf(Set);
            // That includes the added items in the correct order
            expect(Array.from(items)).to.deep.equal([52, 47]);
        });
        it("doesn't call the reaper with an empty queue", () => {
            // Given an empty Batch
            const q = batch<any>(_ => log("ran"), noop);
            // When flush is called
            q.flush();
            // Then the reaper should not run
            see();
        });
        it("won't run while already flushing", () => {
            // Given a queue that reaps and runs callbacks
            const q = batch<() => void>(
                items => { log("reaping"); runCallbacks(items); },
                noop,
            );
            // With a callback that reruns flush()
            q.add(() => { log("first"); q.flush(); log(q.isEmpty()); log("done"); });
            // While there's still another item in the queue
            q.add(() => log("second"));
            // When the queue is flushed
            q.flush();
            // Then the nested flush should not empty the scheduler or rerun the reaper
            see("reaping", "first", "false", "done", "second");
        });
        it("will reschedule itself after reap if items are still queued", () => {
            // Given a queue that reaps and runs callbacks
            var scheduledFlush: () => unknown;
            const q = batch<() => void>(
                runCallbacks,
                f => { scheduledFlush = f; log("scheduled")},
            );
            // With two callbacks, the first of which throws an error
            q.add(() => {throw new Error});
            q.add(() => log("run"));
            // Which has therefore scheduled itself
            see("scheduled");
            // When the queue is flushed on schedule and the error thrown
            expect(scheduledFlush).to.throw(Error);
            // Then the scheduler should have scheduled itself to run again
            see("scheduled");
            // And it should run the second callback when flushed on schedule
            scheduledFlush();
            see("run");
        });
    });
});