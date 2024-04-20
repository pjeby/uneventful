import { log, see, describe, expect, it, useRoot, useClock, clock } from "./dev_deps.ts";
import { each, Source, start, fromIterable, sleep, isValue, emitter, mockSource } from "../mod.ts";

describe("each()", () => {
    useRoot();
    useClock();
    function iterStream<T>(src: Source<T>) {
        return start(function*(){
            try {
                for(const {item, next} of yield *each(src)) {
                    yield *sleep(10); log(item); yield next;
                }
                log("done");
            } catch (e) {
                log(`err: ${e}`);
            }
        });
    }
    it("iterates a stream", () => {
        // Given a job that iterates a pausable stream with each()
        const job = iterStream(fromIterable([1,2,3])); see();
        // When it runs the stream should pause between iterations
        clock.tick(10); see("1");
        clock.tick(21); see("2", "3", "done");
        expect(isValue(job.result())).to.be.true;
    });
    it("drops events that occur during the loop body", () => {
        // Given an emitter and a job iterating over it
        const e = emitter<number>(), job = iterStream(e.source);
        // When items are emitted during the loop body
        clock.tick(1); e(1); e(2); see();
        // Then they should be ignored
        clock.tick(20); see("1");
        // And only items emitted while waiting should be seen
        e(3); clock.tick(10); see("3");
        e.end(); clock.tick(1); see("done");
        expect(isValue(job.result())).to.be.true;
    });
    it("throws if stream ends with error", () => {
        // Given an emitter and a job iterating over it
        const e = mockSource<number>(), job = iterStream(e.source);
        clock.tick(1); e(1); clock.tick(10); see("1")
        // When the stream ends with an error
        e.throw("boom");
        // Then the waiting point should throw
        clock.tick(1); see("err: boom");
        expect(isValue(job.result())).to.be.true;
    });
    it("throws if stream starts with error", () => {
        // Given an emitter and a job iterating over it
        const e = mockSource<number>(), job = iterStream(e.source);
        // When the stream starts with an error
        clock.tick(1); e.throw("boom");
        // Then the waiting point should throw
        clock.tick(1); see("err: boom");
        expect(isValue(job.result())).to.be.true;
    });
    it("throws if no `yield next`", async () => {
        // Given an initialized each() iterator
        const e = mockSource<number>(), job = start(function*() {
            return yield *each(e.source);
        })
        clock.tick(1); e(42); const it = (await job)[Symbol.iterator]();
        const res = it.next();  expect(res.done).to.be.false;
        (res.done === false) && expect(res.value.item).to.equal(42);
        // When the iterator is next()'d without a yield next
        // Then it should throw an error
        expect(() => it.next()).to.throw("Must `yield next` in loop");
    });
    it("throws if multiple `yield next`", async () => {
        const e = mockSource<number>(), job = start(function*() {
            // Given an initialized each() iterator
            const it = (yield *each(e.source))[Symbol.iterator]();
            const res = it.next();  expect(res.done).to.be.false;
            if (res.done === false) {
                const {item, next} = res.value;
                expect(item).to.equal(42);
                // When the iterator is next'd twice in a row
                next(() => {});
                try {
                    next(() => {});
                } catch (e) {
                    log(`err: ${e}`);
                }
            }
        })
        clock.tick(1); e(42); await job;
        // Then it should throw an error
        see("err: Error: Multiple `yield next` in loop");
    });
});