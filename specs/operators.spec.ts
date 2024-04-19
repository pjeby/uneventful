import { log, see, describe, expect, it, spy, useRoot, useClock, clock } from "./dev_deps.ts";
import { emitter, fromIterable, fromValue, connect, IsStream, pipe, Source, must, pause, resume, slack, mockSource } from "../src/mod.ts";
import { runPulls } from "../src/scheduling.ts";
import {
    concat, concatAll, concatMap, filter, map, merge, mergeAll, mergeMap, share, skip, skipUntil, skipWhile,
    switchAll, switchMap, take, takeUntil, takeWhile
} from "../src/mod.ts";

function logClose() { log("closed"); }

describe("Operators", () => {
    useRoot();
    describe("concat()", () => {
        it("should emit its inputs in sequence", () => {
            // Given a concat of multiple streams
            const s = concat([fromIterable([1,2]), fromIterable([5, 6])])
            // When it's connected and pulls run
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should emit the values
            // And close
            see("1", "2", "5", "6", "closed");
        });
        it("should end if there are no inputs", () => {
            // Given an empty concat
            const s = concat([]);
            // When it's connected and pulls run
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should be closed with no output
            see("closed");
        });
        it("should be resumable when paused", () => {
            // Given a concat of multiple streams
            const s = concat([fromIterable([1, 2, 3]), fromIterable([5, 6, 7])])
            // When it's connected with a sink that pauses, and pulls run
            const c = connect(s, v => { log(v); !!(v%3) || pause(c) }).must(logClose); runPulls()
            // Then it should emit the values up to the first pause
            see("1", "2", "3");
            // Then continue when resumed
            resume(c); see("5", "6");
            // And close after the final resume
            resume(c); see("7", "closed");
        });
    });
    describe("concatAll()", () => {
        it("should buffer newer streams while older ones are active", () => {
            // Given a concatAll() of an emitter source
            const e = emitter<Source<number>>(), s = concatAll(e.source);
            // When it's connected to a sink
            connect(s, log.emit).must(logClose);
            // And multiple sources are pushed
            e(fromIterable([1, 2])); e(fromIterable([3, 4]));
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "3", "4");
            // And pick up again if more are pushed
            e(fromIterable([5, 6]));
            see(); runPulls(); see("5", "6");
            // But close when the emitter does
            e.end();
            see("closed");
        });
        it("shouldn't end while a stream is still active", () => {
            // Given a concatAll() of an emitter source
            const e = emitter<Source<number>>(), s = concatAll(e.source);
            // When it's connected to a paused sink
            const c = connect(s, log.emit).must(logClose); pause(c);
            // And a source is pushed followed by a close and a resume of the sink
            e(fromIterable([1, 2])); e.end(); resume(c);
            // Then it should see all the output before closing
            see("1", "2", "closed");
        });
    });
    describe("concatMap()", () => {
        it("should buffer newer streams while older ones are active", () => {
            // Given a concatAll() of an emitter source
            const e = emitter<number>(), s = concatMap((n: number) => fromIterable([n, n*2]))(e.source);
            // When it's connected to a sink
            connect(s, log.emit).must(logClose);
            // And multiple sources are pushed
            e(1); e(2);
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "2", "4");
            // And pick up again if more are pushed
            e(3); see(); runPulls(); see("3", "6");
            // But close when the emitter does
            e.end();
            see("closed");
        });
    });
    describe("filter()", () => {
        it("passes values to the condition", () => {
            // Given a stream filtered on values
            const s = pipe(
                fromIterable([1, 2, 3, 4, 5]),
                filter(v => !!(v % 2))
            );
            // When subscribed and pulls run
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should output the matching values
            see("1", "3", "5", "closed");
        });
        it("passes indexes to the condition", () => {
            // Given a stream filtered on index
            const s = pipe(
                fromIterable(["a", "b", "c", "d"]),
                filter((_,i) => !!(i % 2))
            );
            // When subscribed and pulls run
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should output the matching values
            see("b", "d", "closed");
        });
    });
    describe("map()", () => {
        it("passes values to the mapper", () => {
            // Given a stream mapped on values
            const s = pipe(
                fromIterable([1, 2, 3]),
                map(v => v * 2)
            );
            // When subscribed and pulled
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should output the matching values
            see("2", "4", "6", "closed");
        });
        it("passes indexes to the mapper", () => {
            // Given a stream mapped on index
            const s = pipe(
                fromIterable([1, 2, 3]),
                map((v,i) => v*i)
            );
            // When subscribed and pulled
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should output the matching values
            see("0", "2", "6", "closed");
        });
    });
    describe("merge()", () => {
        useClock();
        it("should emit when any input does", () => {
            // Given a merge of two emitters
            const e1 = emitter<number>(), e2 = emitter<string>();
            const s = merge<number|string>([e1.source, e2.source]);
            // When connected and pulled
            const c = connect(s, log.emit); runPulls();
            // Then it should emit values from either
            e1(1); see("1");
            e2("a"); see("a");
            c.end();
        });
        it("should close after all inputs do", () => {
            // Given a merge of two values
            const s = merge([fromValue(1), fromValue(2)]);
            // When it's connected and they both start
            connect(s, log.emit).must(logClose); runPulls(); clock.tick(0);
            // Then it should emit values from both
            // And then close
            see("1", "2", "closed");
        });
        it("should be resumable when paused", () => {
            // Given a merge of multiple streams
            const s = merge([fromIterable([2, 3, 4]), fromIterable([6, 7, 8])])
            // When it's connected with a sink that pauses
            const c = connect(s, v => { log(v); !!(v%3) || pause(c); }).must(logClose);
            // Then it should emit values and pause accordingly, resuming on request
            runPulls(); see("2", "3");
            resume(c); see("6");
            // And close after the final pull
            resume(c); see("4", "7", "8", "closed");
        });
    });
    describe("mergeAll()", () => {
        it("closes when the outer stream does (if no pending substreams)", () => {
            // Given a mergeAll() of an emitter
            const e = emitter<Source<number>>(), s = mergeAll(e.source);
            // When it's connected to a sink
            connect(s, log.emit).must(logClose);
            // And multiple sources are pushed
            e(fromIterable([1, 2])); e(fromIterable([3, 4]));
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "3", "4");
            // And pick up again if more are pushed
            e(fromIterable([5, 6]));
            see(); runPulls(); see("5", "6");
            // But close when the emitter does
            e.end();
            see("closed");
        });
    });
    describe("mergeMap()", () => {
        it("closes when the outer stream does (if no pending substreams)", () => {
            // Given a mergeMap() of an emitter
            const e = emitter<number>(), s = mergeMap(
                (n: number) => fromIterable([n, n*2])
            )(e.source);
            // When it's connected to a sink
            connect(s, log.emit).must(logClose);
            // And multiple sources are pushed
            e(1); e(2);
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "2", "4");
            // And pick up again if more are pushed
            e(3);
            see(); runPulls(); see("3", "6");
            // But close when the emitter does
            e.end();
            see("closed");
        });
    });
    describe("share()", () => {
        it("should subscribe/close based on demand", () => {
            // Given a shared source
            const src = spy((_sink) => (must(logClose), IsStream)), s = share(src);
            // When it's subscribed twice
            const c1 = connect(s, log.emit);
            const c2 = connect(s, log.emit);
            // Then the upstream should only be called once
            expect(src).to.have.been.calledOnce;
            // Even if it's unsubscribed and subscribed again
            c1.end();
            const c3 = connect(s, log.emit);
            expect(src).to.have.been.calledOnce;
            // And its original connection should still be open
            see();
            // Unless all the subscribers close
            c2.end(); c3.end();
            see("closed");
            // And a new connection is opened
            const c4 = connect(s, log.emit);
            // In which case it's called again
            expect(src).to.have.been.calledTwice
            c4.end();
        });
        it("pauses if all subscribers pause, resumes if any resume", () => {
            // Given a shared synchronous source
            const s = share(fromIterable([1, 2, 3, 4, 5, 6, 7]));
            // When it's connected and pulled with a sink that pauses
            const c = connect(s, v => { log(v); !!(v%3) || pause(c) }).must(logClose);
            see(); runPulls();
            // Then it should emit values until the pause
            see("1", "2", "3");
            // But if another connection is added and pulled (w/non-pausing sink)
            connect(s, log.emit).must(logClose); see(); runPulls();
            // Then both connections see all the remaining values without pausing
            // And they should both close
            see("4", "4", "5", "5", "6", "6", "7", "7", "closed", "closed");
        });
    });
    describe("skip()", () => {
        it("should skip N items", () => {
            // Given a skip of a source
            const s = skip(3)(fromIterable([65,9,23,42,51,67]));
            // When it's connected and pulled
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should emit the remaining values
            // And then close
            see("42", "51", "67", "closed");
        });
    });
    describe("skipUntil()", () => {
        it("skips items until the notifier emits", () => {
            // Given a skipUntil()
            const input = emitter(), notify = emitter();
            const s = pipe(input.source, skipUntil(notify.source));
            // When it's subscribed and pulled
            const c = connect(s, log.emit); runPulls();
            // Then inputs are ignored
            input(42); see();
            input(43); see();
            // Until the notifier emits
            notify(undefined);
            // And then outputs will be visible
            input(44); see("44");
            c.end();
        });
    });
    describe("skipWhile()", () => {
        it("skips values until one matches a condition", () => {
            // Given a subscribed skipWhile()
            const cond = spy(v => !!(v % 3)), input = emitter();
            const s = pipe(input.source, skipWhile(cond));
            connect(s, log.emit).must(logClose); runPulls();
            // When items are emitted
            // Then they are skipped
            input(44); see();
            input(43); see();
            // Until the condition matches
            input(42); see("42");
            // And then subsequent items are accepted even if they don't match
            input(41); see("41");
            input(44); see("44");
            // And the output should close with the input
            input.end();
            see("closed");
        });
    });
    describe("slack()", () => {
        function dropper(v: any) { log(`drop: ${v}`); }
        it("drops everything when paused (w/size=0)", () => {
            // Given a connection to a mockSource piped through slack 0
            const e=mockSource<number>(), c = connect(pipe(e.source, slack(0, dropper)), log).must(logClose);
            // When items are emitted, they pass through immediately
            e(1); see("1");
            // But when the connection is pasued, they are dropped
            pause(c); e(2); see("drop: 2");
            // Until the connection is resumed
            resume(c); e(3); see("3");
            // And it closes when the upstream does
            e.end(); see("closed");
        });
        it("buffers newest items when paused (w/size > 0)", () => {
            // Given a connection to a mockSource piped through slack 2
            const e=mockSource<number>(), c = connect(pipe(e.source, slack(2, dropper)), log).must(logClose);
            // When items are emitted, they pass through immediately
            e(1); see("1");
            // And the upstream is unpaused
            expect(e.ready()).to.be.true;
            // But when the connection is pasued, they are buffered
            pause(c); e(2);
            // Until the connection is resumed (and upstream is resumed)
            resume(c); see("2"); e(3); see("3");
            // And the upstream is paused when the buffer is full
            pause(c); e(4); see(); e(5); see();
            expect(e.ready()).to.be.false;
            // And if the buffer overflows, older items are dropped
            e(6); see("drop: 4");
            // And only the newest items are seen on resume
            // with the upstream resuming only once there's room in the buffer
            e.ready(()=>log("resumed")); resume(c); see("5", "resumed", "6");
            expect(e.ready()).to.be.true;
            // And it closes when the upstream does
            e.end(); see("closed");
        });
        it("buffers oldest items when paused (w/size > 0)", () => {
            // Given a connection to a mockSource piped through slack -2
            const e=mockSource<number>(), c = connect(pipe(e.source, slack(-2, dropper)), log).must(logClose);
            // When items are emitted, they pass through immediately
            e(1); see("1");
            // And the upstream is unpaused
            expect(e.ready()).to.be.true;
            // But when the connection is pasued, they are buffered
            pause(c); e(2);
            // Until the connection is resumed
            resume(c); see("2"); e(3); see("3");
            // And the upstream is paused when the buffer is full
            pause(c); e(4); see(); e(5); see();
            expect(e.ready()).to.be.false;
            // And if the buffer overflows, newer items are dropped
            e(6); see("drop: 6");
            // And only the oldest items are seen on resume,
            // with the upstream resuming only once there's room in the buffer
            e.ready(()=>log("resumed")); resume(c); see("4", "resumed", "5");
            // And it closes when the upstream does
            e.end(); see("closed");
        });
        // XXX these scenarios need each() in order to test them:
        // - stops draining when sink pauses
        // - handles re-entry if sink triggers an emission from upstream
    });
    describe("switchAll()", () => {
        it("switches to its latest input stream", () => {
            // Given a subscribed switchAll of an emitter
            const input = emitter<Source<number>>();
            const s = switchAll(input.source);
            connect(s, log.emit).must(logClose);
            // When a source is pushed
            input(fromIterable([1, 2, 3]))
            // Then its output should be seen
            runPulls(); see("1", "2", "3");
            // But if a source is in progress
            const sub = emitter<number>();
            input(sub.source);
            sub(1); see("1");
            sub(2); see("2");
            // And a new source is pushed
            input(fromIterable([41, 42, 43]));
            // Then the new source's output should be seen
            runPulls(); see("41", "42", "43");
            // But not the old one's
            sub(3); runPulls(); see();
            // And it should close when the input does
            input.end();
            see("closed");
        });
        it("ends after its last stream ends", () => {
            // Given a subscribed switchAll()
            const input = emitter<number>();
            const s = switchAll(fromIterable([input.source]));
            connect(s, log.emit).must(logClose); runPulls();
            // When the last inner source ends
            input(42); see("42"); input.end();
            // Then the output should be ended as well
            see("closed");
        });
        it("resumes inner streams", () => {
            // Given a switchAll() with an inner synchronous stream
            const s = switchAll(fromIterable([
                fromIterable([1,2,3,4,5,6,7])
            ]));
            // When it's subscribed with a pausing sink
            const c = connect(s, v => { log(v); !!(v%3)|| pause(c); }).must(logClose);
            // Then output should pause
            runPulls(); see("1", "2", "3");
            // And resume on demand
            resume(c); runPulls(); see("4", "5", "6");
            // And finally close
            resume(c); runPulls(); see("7", "closed");
        });
    });
    describe("switchMap()", () => {
        it("maps inputs to streams", () => {
            // Given a subscribed switchMap of an emitter source
            const input = emitter<number>();
            const s = switchMap((n: number) => fromIterable([n, n*2]))(input.source);
            connect(s, log.emit).must(logClose);
            // When a value is input
            input(17); runPulls();
            // Then it's mapped to a stream on the output
            see("17", "34");
            // And ends when the input ends
            input.end();
            see("closed");
        });
    });
    describe("take()", () => {
        it("should take N items", () => {
            // Given a take of a source
            const s = take(3)(fromIterable([65,9,23,42,51,67]));
            // When it's connected and pulled
            connect(s, log.emit).must(logClose); runPulls();
            // Then it should emit the remaining values
            // And then close
            see("65", "9", "23", "closed");
        });
    });
    describe("takeUntil()", () => {
        it("passes output through until notified", () => {
            // Given a subscribed takeUntil
            const input = emitter(), notify = emitter();
            const s = pipe(input.source, takeUntil(notify.source));
            connect(s, log.emit).must(logClose);
            // When the input emits
            input(42); input(27); input(59);
            // Then the values should be seen
            see("42", "27", "59");
            // Until the notifier emits
            notify(99);
            // And Then the stream should close
            see("closed");
        });
    });
    describe("takeWhile()", () => {
        it("takes values until one matches a condition", () => {
            // Given a subscribed takeWhile()
            const cond = spy(v => !!(v % 3)), input = emitter();
            const s = pipe(input.source, takeWhile(cond));
            connect(s, log.emit).must(logClose); runPulls();
            // When items are emitted
            // Then they are taken
            input(44); see("44");
            input(43); see("43");
            // Until the condition matches (closing the output)
            input(42); see("closed");
            // And then subsequent items are skipped even if they don't match
            input(41); see();
            input(44); see();
            input.end();
        });
    });
});