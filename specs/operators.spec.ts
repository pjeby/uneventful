import { log, see, describe, expect, it, spy } from "./dev_deps.ts";
import { connect, pipe, Source } from "../src/mod.ts";
import { emitter, fromIterable, fromValue } from "../src/sources.ts";
import { runPulls } from "../src/streams.ts";
import {
    concat, concatAll, concatMap, filter, map, merge, mergeAll, mergeMap, share, skip, skipUntil, skipWhile,
    switchAll, switchMap, take, takeUntil, takeWhile
} from "../src/operators.ts";

describe("Operators", () => {
    describe("concat()", () => {
        it("should emit its inputs in sequence", () => {
            // Given a concat of multiple streams
            const s = concat([fromIterable([1,2]), fromIterable([5, 6])])
            // When it's connected and pulls run
            const c = connect.root(s, log.emit); runPulls();
            // Then it should emit the values
            see("1", "2", "5", "6");
            // And close
            expect(c.isOpen()).to.be.false;
        });
        it("should end if there are no inputs", () => {
            // Given an empty concat
            const s = concat([]);
            // When it's connected and pulls run
            const c = connect.root(s, log.emit); runPulls();
            // Then it should be closed with no output
            see();
            expect(c.isOpen()).to.be.false;
        });
        it("should be resumable when paused", () => {
            // Given a concat of multiple streams
            const s = concat([fromIterable([1, 2, 3]), fromIterable([5, 6, 7])])
            // When it's connected with a sink that pauses, and pulls run
            const c = connect.root(s, v => { log(v); return !!(v%3) }); runPulls()
            // Then it should emit the values up to the first pause
            see("1", "2", "3");
            // Then continue when resumed
            c.resume(); see("5", "6");
            // And close after the final resume
            c.resume(); see("7");
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("concatAll()", () => {
        it("should buffer newer streams while older ones are active", () => {
            // Given a concatAll() of an emitter source
            const e = emitter<Source<number>>(), s = concatAll(e.source);
            // When it's connected to a sink
            const c = connect.root(s, log.emit);
            // And multiple sources are pushed
            e(fromIterable([1, 2])); e(fromIterable([3, 4]));
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "3", "4");
            // And pick up again if more are pushed
            e(fromIterable([5, 6]));
            see(); runPulls(); see("5", "6");
            // But close when the emitter does
            e.close();
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("concatMap()", () => {
        it("should buffer newer streams while older ones are active", () => {
            // Given a concatAll() of an emitter source
            const e = emitter<number>(), s = concatMap((n: number) => fromIterable([n, n*2]))(e.source);
            // When it's connected to a sink
            const c = connect.root(s, log.emit);
            // And multiple sources are pushed
            e(1); e(2);
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "2", "4");
            // And pick up again if more are pushed
            e(3); see(); runPulls(); see("3", "6");
            // But close when the emitter does
            e.close();
            expect(c.isOpen()).to.be.false;
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
            const c = connect.root(s, log.emit); runPulls();
            // Then it should output the matching values
            see("1", "3", "5");
            expect(c.isOpen()).to.be.false;
        });
        it("passes indexes to the condition", () => {
            // Given a stream filtered on index
            const s = pipe(
                fromIterable(["a", "b", "c", "d"]),
                filter((_,i) => !!(i % 2))
            );
            // When subscribed and pulls run
            const c = connect.root(s, log.emit); runPulls();
            // Then it should output the matching values
            see("b", "d");
            expect(c.isOpen()).to.be.false;
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
            const c = connect.root(s, log.emit); runPulls();
            // Then it should output the matching values
            see("2", "4", "6");
            expect(c.isOpen()).to.be.false;
        });
        it("passes indexes to the mapper", () => {
            // Given a stream mapped on index
            const s = pipe(
                fromIterable([1, 2, 3]),
                map((v,i) => v*i)
            );
            // When subscribed and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then it should output the matching values
            see("0", "2", "6");
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("merge()", () => {
        it("should emit when any input does", () => {
            // Given a merge of two emitters
            const e1 = emitter<number>(), e2 = emitter<string>();
            const s = merge<number|string>([e1.source, e2.source]);
            // When connected and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then it should emit values from either
            e1(1); see("1");
            e2("a"); see("a");
            c.close();
        });
        it("should close after all inputs do", () => {
            // Given a merge of two values
            const s = merge([fromValue(1), fromValue(2)]);
            // When it's connected and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then it should emit values from both
            see("1", "2");
            // And then close
            expect(c.isOpen()).to.be.false;
        });
        it("should be resumable when paused", () => {
            // Given a merge of multiple streams
            const s = merge([fromIterable([2, 3, 4]), fromIterable([6, 7, 8])])
            // When it's connected with a sink that pauses
            const c = connect.root(s, v => { log(v); return !!(v%3) });
            // Then it should emit values and pause accordingly, resuming on request
            runPulls(); see("2", "3");
            c.resume(); see("6");
            c.resume(); see("4", "7", "8");
            // And close after the final pull
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("mergeAll()", () => {
        it("closes when the outer stream does (if no pending substreams)", () => {
            // Given a mergeAll() of an emitter
            const e = emitter<Source<number>>(), s = mergeAll(e.source);
            // When it's connected to a sink
            const c = connect.root(s, log.emit);
            // And multiple sources are pushed
            e(fromIterable([1, 2])); e(fromIterable([3, 4]));
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "3", "4");
            // And pick up again if more are pushed
            e(fromIterable([5, 6]));
            see(); runPulls(); see("5", "6");
            // But close when the emitter does
            e.close();
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("mergeMap()", () => {
        it("closes when the outer stream does (if no pending substreams)", () => {
            // Given a mergeMap() of an emitter
            const e = emitter<number>(), s = mergeMap(
                (n: number) => fromIterable([n, n*2])
            )(e.source);
            // When it's connected to a sink
            const c = connect.root(s, log.emit);
            // And multiple sources are pushed
            e(1); e(2);
            // Then it should see all the output
            see(); runPulls(); see("1", "2", "2", "4");
            // And pick up again if more are pushed
            e(3);
            see(); runPulls(); see("3", "6");
            // But close when the emitter does
            e.close();
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("share()", () => {
        it("should subscribe/close based on demand", () => {
            // Given a shared source
            const src = spy(), s = share(src);
            // When it's subscribed twice
            const c1 = connect.root(s, log.emit);
            const c2 = connect.root(s, log.emit);
            // Then the upstream should only be called once
            expect(src).to.have.been.calledOnce;
            // Even if it's unsubscribed and subscribed again
            c1.close();
            const c3 = connect.root(s, log.emit);
            expect(src).to.have.been.calledOnce;
            // And its original connection should still be open
            expect(src.args[0][0].isOpen()).to.be.true;
            // Unless all the subscribers close
            c2.close(); c3.close();
            expect(src.args[0][0].isOpen()).to.be.false;
            // And a new connection is opened
            const c4 = connect.root(s, log.emit);
            // In which case it's called again
            expect(src).to.have.been.calledTwice
            c4.close();
        });
        it("pauses if all subscribers pause, resumes if any resume", () => {
            // Given a shared synchronous source
            const s = share(fromIterable([1, 2, 3, 4, 5, 6, 7]));
            // When it's connected and pulled with a sink that pauses
            const c1 = connect.root(s, v => { log(v); return !!(v%3) });
            see(); runPulls();
            // Then it should emit values until the pause
            see("1", "2", "3");
            // But if another connection is added and pulled (w/non-pausing sink)
            const c2 = connect.root(s, log.emit); see(); runPulls();
            // Then both connections see all the remaining values without pausing
            see("4", "4", "5", "5", "6", "6", "7", "7");
            // And they should both close
            expect(c1.isOpen()).to.be.false;
            expect(c2.isOpen()).to.be.false;
        });
    });
    describe("skip()", () => {
        it("should skip N items", () => {
            // Given a skip of a source
            const s = skip(3)(fromIterable([65,9,23,42,51,67]));
            // When it's connected and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then it should emit the remaining values
            see("42", "51", "67");
            // And then close
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("skipUntil()", () => {
        it("skips items until the notifier emits", () => {
            // Given a skipUntil()
            const input = emitter(), notify = emitter();
            const s = pipe(input.source, skipUntil(notify.source));
            // When it's subscribed and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then inputs are ignored
            input(42); see();
            input(43); see();
            // Until the notifier emits
            notify(undefined);
            // And then outputs will be visible
            input(44); see("44");
            c.close();
        });
    });
    describe("skipWhile()", () => {
        it("skips values until one matches a condition", () => {
            // Given a subscribed skipWhile()
            const cond = spy(v => !!(v % 3)), input = emitter();
            const s = pipe(input.source, skipWhile(cond));
            const c = connect.root(s, log.emit); runPulls();
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
            input.close();
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("switchAll()", () => {
        it("switches to its latest input stream", () => {
            // Given a subscribed switchAll of an emitter
            const input = emitter<Source<number>>();
            const s = switchAll(input.source);
            const c = connect.root(s, log.emit);
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
            input.close();
            expect(c.isOpen()).to.be.false;
        });
        it("ends after its last stream ends", () => {
            // Given a subscribed switchAll()
            const input = emitter<number>();
            const s = switchAll(fromIterable([input.source]));
            const c = connect.root(s, log.emit); runPulls();
            // When the last inner source closes
            input(42); see("42"); input.close();
            // Then the output should be closed
            expect(c.isOpen()).to.be.false;
        });
        it("resumes inner streams", () => {
            // Given a switchAll() with an inner synchronous stream
            const s = switchAll(fromIterable([
                fromIterable([1,2,3,4,5,6,7])
            ]));
            // When it's subscribed with a pausing sink
            const c = connect.root(s, v => { log(v); return !!(v%3) });
            // Then output should pause
            runPulls(); see("1", "2", "3");
            // And resume on demand
            c.resume(); runPulls(); see("4", "5", "6");
            c.resume(); runPulls(); see("7");
            // And finally close
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("switchMap()", () => {
        it("maps inputs to streams", () => {
            // Given a subscribed switchMap of an emitter source
            const input = emitter<number>();
            const s = switchMap((n: number) => fromIterable([n, n*2]))(input.source);
            const c = connect.root(s, log.emit);
            // When a value is input
            input(17); runPulls();
            // Then it's mapped to a stream on the output
            see("17", "34");
            // And closes when the input is closed
            input.close();
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("take()", () => {
        it("should take N items", () => {
            // Given a take of a source
            const s = take(3)(fromIterable([65,9,23,42,51,67]));
            // When it's connected and pulled
            const c = connect.root(s, log.emit); runPulls();
            // Then it should emit the remaining values
            see("65", "9", "23");
            // And then close
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("takeUntil()", () => {
        it("passes output through until notified", () => {
            // Given a subscribed takeUntil
            const input = emitter(), notify = emitter();
            const s = pipe(input.source, takeUntil(notify.source));
            const c = connect.root(s, log.emit);
            // When the input emits
            input(42); input(27); input(59);
            // Then the values should be seen
            see("42", "27", "59");
            // Until the notifier emits
            notify(99);
            // And Then the stream should close
            expect(c.isOpen()).to.be.false;
        });
    });
    describe("takeWhile()", () => {
        it("takes values until one matches a condition", () => {
            // Given a subscribed takeWhile()
            const cond = spy(v => !!(v % 3)), input = emitter();
            const s = pipe(input.source, takeWhile(cond));
            const c = connect.root(s, log.emit); runPulls();
            // When items are emitted
            // Then they are taken
            input(44); see("44");
            input(43); see("43");
            // Until the condition matches
            input(42); see();
            // And then subsequent items are skipped even if they don't match
            input(41); see();
            input(44); see();
            // And the output should close with the input
            input.close();
            expect(c.isOpen()).to.be.false;
        });
    });
});