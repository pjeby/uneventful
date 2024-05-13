import { log, see, describe, expect, it, useRoot, useClock, clock, msg } from "./dev_deps.ts";
import { each, Source, start, fromIterable, sleep, isValue, emitter, mockSource, Connection, isHandled, forEach, must, Sink, throttle, Job, Inlet, Producer, pipe } from "../mod.ts";

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
        let conn: Connection;
        const e = mockSource<number>(), job = iterStream(
            // Capture the connection so we can make sure its errors
            // are marked handled
            (s,c) => e.source(s, conn=c)
        );
        clock.tick(1); e(1); clock.tick(10); see("1")
        conn.must(r => log(isHandled(r))).do(r => log(isHandled(r)))  // log before-and-after handledness
        // When the stream ends with an error
        e.throw("boom");
        // Then the waiting point should throw
        // And the connection error should be marked handled
        clock.tick(1); see("false", "true", "err: boom");
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

describe("forEach()", () => {
    useRoot();
    it("calls the source w/a restarting sink, the job, and the inlet", () => {
        // Given a mock source and throttle
        const emit = mockSource<number>(), t = throttle();
        let received: Job;
        // When iterated with forEach
        const conn = forEach((s, j, i) => {
            received = j;
            log(i === t);
            return emit.source(s, j, i);
        }, (x: number) => {
            log(`got: ${x}`); must(msg(`restart: ${x}`));
        }, t);
        // Then the source should receive the matching job and throttle
        see("true");
        expect(received).to.equal(conn);
        // And the sink should be run in a job that restarts on each new value
        emit(17); see("got: 17");
        emit(42); see("restart: 17", "got: 42");
        // And ends with the connection
        emit.end(); see("restart: 42");
        expect(isValue(conn.result())).to.be.true;
    });
    it("works as a pipe() target", () => {
        // Given a mock source and throttle
        const emit = mockSource<number>(), t = throttle();
        let received: Job;
        const src = (s: Sink<number>, j: Connection, i: Inlet) => {
            received = j;
            log(i === t);
            return emit.source(s, j, i);
        }
        // When iterated with forEach through a pipe()
        const conn = pipe(src, forEach((x: number) => {
            log(`got: ${x}`); must(msg(`restart: ${x}`));
        }, t));
        // Then the source should receive the matching job and throttle
        see("true");
        expect(received).to.equal(conn);
        // And the sink should be run in a job that restarts on each new value
        emit(17); see("got: 17");
        emit(42); see("restart: 17", "got: 42");
        // And ends with the connection
        emit.end(); see("restart: 42");
        expect(isValue(conn.result())).to.be.true;
    });
});
