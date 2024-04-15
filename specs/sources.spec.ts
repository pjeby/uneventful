import {
    log, waitAndSee, see, describe, expect, it, useClock, clock, useRoot, createStubInstance, spy
} from "./dev_deps.ts";
import { connect, value, runEffects, isError, FlowResult, isValue } from "../src/mod.ts";
import { runPulls } from "../src/scheduling.ts";
import { Connector, pause, resume } from "../src/streams.ts";
import {
    emitter, empty, fromAsyncIterable, fromDomEvent, fromIterable, fromPromise, fromSignal,
    fromValue, fromSubscribe, interval, lazy, never
} from "../src/sources.ts";

function logClose(e: FlowResult<void>) { log("closed"); if (isError(e)) log(`err: ${e.err}`)}

describe("Sources", () => {
    useRoot();
    describe("emitter()", () => {
        it("should emit/close the source when called", () => {
            // Given an emitter
            const e = emitter<any>();
            // When its source is subscribed and pulled
            connect(e.source, log.emit).must(logClose); runPulls();
            // Then calling the emitter should emit values
            e(42); see("42");
            e(43); see("43");
            // And ending it should end the source
            e.end();
            see("closed");
            // But it should still be subscribable
            const c2 = connect(e.source, log.emit); runPulls();
            e(44); see("44");
            e(45); see("45");
            c2.end();
        });
        it("should be ok with no subscribers", () => {
            // Given an emitter
            const e = emitter<any>();
            // Then calling it should do nothing
            e(42);
        });
        it("should be ok with multiple subscribers", () => {
            // Given an emitter
            const e = emitter<any>();
            // When its source is subscribed and pulled with two sinks at different times
            const c1 = connect(e.source, log.emit); runPulls();
            e(42); see("42");
            let emits = 0;
            const c2 = connect(e.source, v => (emits++, true)); runPulls();
            // Then it should emit to the currently-subscribed sinks
            e(43); see("43"); expect(emits).to.equal(1);
            // Until their connections close
            c1.end();
            e(44); see(); expect(emits).to.equal(2);
            c2.end();
            e(45); see(); expect(emits).to.equal(2);
        });
        it("should throw to its subscriber(s)", () => {
            // Given an emitter
            const e = emitter<any>();
            // When its source is subscribed and pulled
            const c = connect(e.source, log.emit).must(r => {
                if (isError(r)) log(`err: ${r.err}`);
            }); runPulls();
            // And the emitter throws
            e.throw("a reason");
            // Then the connection should be thrown as well
            see("err: a reason");
        });
        it("should close() to its subscriber(s)", () => {
            // Given an emitter
            const e = emitter<any>();
            // When its source is subscribed and pulled
            connect(e.source, log.emit).must(logClose); runPulls();
            // And the emitter is ended
            e.end();
            // Then the connection should be closed
            see("closed");
        });
    });
    describe("empty()", () => {
        it("immediately closes", () => {
            // Given an empty stream
            const s = empty()
            // When it's subscribed
            const c = connect(s, log.emit);
            // Then it should close the connection
            expect(isValue(c.result())).to.be.true;
        });
    });
    describe("fromDomEvent()", () => {
        it("should subscribe w/pusher and unsub on close", () => {
            // Given a fromDomEvent() stream
            const target = createStubInstance(EventTarget), options = {};
            const s = fromDomEvent(target as any, "blur", options);
            // When it's connected
            const c = connect(s, log.emit);
            // Then its addEventListener should be called with a pusher and matching options
            expect(target.addEventListener).to.have.been.calledOnce;
            expect(target.removeEventListener).not.to.have.been.called;
            const pusher = target.addEventListener.args[0][1];
            expect(target.addEventListener).to.have.been.calledOnceWithExactly("blur", pusher, options);
            // And the pusher should emit from the stream
            see(); (pusher as any)("push"); see("push");
            // And its removeEventListener should be called when the stream is closed
            c.end();
            expect(target.removeEventListener).to.have.been.calledOnceWithExactly("blur", pusher, options);
        });
    });
    describe("fromAsyncIterable()", () => {
        it("should output all the values, then close", async () => {
            // Given an async iterable
            const iterable = {async *[Symbol.asyncIterator]() {
                yield 1; yield 2; yield 3; yield "a"; yield "b"; yield "c";
            }};
            // and a fromAsyncIterable based on it
            const s = fromAsyncIterable(iterable);
            // When it's subscribed
            const c = connect(s, log.emit).must(logClose);
            // Then it should asynchronously output it values after the next tick
            // And close the connection
            see();
            await waitAndSee("1", "2", "3", "a", "b", "c", "closed");
        });
        it("should pause and resume per protocol", async () => {
            // Given an async iterable
            const iterable = {async *[Symbol.asyncIterator]() {
                yield 1; yield 2; yield 3; yield "a"; yield "b"; yield "c";
            }};
            // and a fromAsyncIterable based on it
            const s = fromAsyncIterable(iterable);
            // When it's subscribed and pulled with a pausing sink
            const c = connect(s, v => (log(v), v !== 3)).must(logClose);
            see(); runPulls();
            // Then it should output the values up to the pause after the next tick
            // And the connection should still be open
            await waitAndSee("1", "2", "3");
            // And When the connection is resumed
            resume(c)
            see();
            // Then it should output the rest on the next tick
            // And close the connection
            runPulls();
            await waitAndSee("a", "b", "c", "closed");
        });
        it("should close the iterator when the stream closes", async () => {
            // Given an iterable with a return()
            const iterable = {async *[Symbol.asyncIterator]() {
                try {
                    for (let i=1; i<=10; i++) yield i;
                } finally {
                    log("return");
                }
            }};
            // and a fromAsyncIterable based on it
            const s = fromAsyncIterable(iterable);
            // When it's subscribed and pulled with a pausing sink
            const c = connect(s, v => (log(v), v !== 3)).must(logClose);
            // Then it should output the values up to the pause on the next tick
            // And the connection should still be open
            runPulls();
            see();
            await waitAndSee("1", "2", "3");
            // And When the connection is closed
            c.end();
            // Then the iterator should be return()ed
            await waitAndSee("closed", "return");
        });
        it("should throw if the iterator does", async () => {
            // Given an async iterable that throws
            const iterable = {async *[Symbol.asyncIterator]() {
                for (let i=1; i<=5; i++) yield i;
                throw new Error;
            }};
            // and a fromAsyncIterable based on it
            const s = fromAsyncIterable(iterable);
            // When it's subscribed
            const c = connect(s, log.emit).must(logClose);
            // Then it should output the values up to the error (asynchronously)
            // And then throw
            see();
            await waitAndSee("1", "2", "3", "4", "5", "closed", "err: Error");
        })
    });
    describe("fromIterable()", () => {
        it("should output all the values, then close", () => {
            // Given a fromIterable() stream
            const s = fromIterable([1,2,3,"a","b","c"]);
            // When it's subscribed
            const c = connect(s, log.emit).must(logClose);
            // Then it should output all the values once pulled
            // And close the connection
            see();
            runPulls();
            see("1", "2", "3", "a", "b", "c", "closed");
        });
        it("should pause and resume per protocol", () => {
            // Given a fromIterable() stream
            const s = fromIterable([1,2,3,"a","b","c"]);
            // When it's subscribed with a pausing sink
            const c = connect(s, v => (log(v), v === 3 && pause(c))).must(logClose);
            // Then it should output the values up to the pause on the next tick
            // And the connection should still be open
            see(); runPulls(); see("1", "2", "3");
            // And When the connection is resumed
            resume(c);
            // Then it should output the rest
            // And close the connection
            see("a", "b", "c", "closed");
        });
        it("should close the iterator when the stream closes", () => {
            // Given an iterable with a return()
            const iterable = {*[Symbol.iterator]() {
                try {
                    for (let i=1; i<=10; i++) yield i;
                } finally {
                    log("return");
                }
            }};
            // and a fromIterable based on it
            const s = fromIterable(iterable);
            // When it's subscribed and pulled with a pausing sink
            const c: Connector = connect(s, v => (log(v), v === 3 && pause(c))).must(logClose);
            // Then it should output the values up to the pause on the next tick
            // And the connection should still be open
            see();
            runPulls();
            see("1", "2", "3");
            // And When the connection is closed
            c.end();
            // Then the iterator should be return()ed
            see("closed", "return");
        });
        it("should throw if the iterator does", () => {
            // Given an iterable that throws
            const iterable = {*[Symbol.iterator]() {
                for (let i=1; i<=5; i++) yield i;
                throw new Error;
            }};
            // and a fromIterable based on it
            const s = fromIterable(iterable);
            // When it's subscribed and pulled
            const c = connect(s, log.emit).must(logClose);
            // Then it should output the values up to the error
            // And then throw
            see();
            runPulls();
            see("1", "2", "3", "4", "5", "closed", "err: Error");
        })
    });
    describe("fromPromise()", () => {
        useClock();
        it("should resolve native Promises", async () => {
            // Given a fromPromise() of a resolved native promise
            const s = fromPromise(Promise.resolve(42));
            // When the stream is connected
            connect(s, log.emit).must(logClose);
            // Then it should emit the resolved value asynchronously
            // And the stream should be closed
            see(); await Promise.resolve(); see("42", "closed");
        });
        it("should reject rejected native promises", async () => {
            // Given a fromPromise() of a rejected native promise
            const s = fromPromise(Promise.reject("some reason"));
            // When the stream is connected
            const c = connect(s, log.emit).must(logClose);
            // Then it should throw the connection asynchronously
            see(); await Promise.resolve(); see("closed", "err: some reason");
        });
        it("should await pending promises", async () => {
            // Given a fromPromise() of a pending native promise
            const s = fromPromise(new Promise((resolve) => {
                setTimeout(() => resolve(99), 50);
            }));
            // When the stream is connected
            connect(s, log.emit).must(logClose);
            // Then it should do nothing
            see(); await Promise.resolve(); see();
            // Until the promise is resolved
            clock.tick(50);
            // And then it should emit the resolved value asynchronously
            // And the stream should be closed
            see(); await Promise.resolve(); see("99", "closed");
        });
        it("should resolve plain values", async () => {
            // Given a fromPromise() of a plain value
            const s = fromPromise(42);
            // When the stream is connected
            connect(s, log.emit).must(logClose);
            // Then it should emit the resolved value asynchronously
            // And the stream should be closed
            see(); await Promise.resolve(); see("42", "closed");
        });
        it("should resolve promise-like objects", async () => {
            // Given a fromPromise() of a "thenable"
            const s = fromPromise({then(onV) { onV(42); }});
            // When the stream is connected
            connect(s, log.emit).must(logClose);
            // Then it should emit the resolved value asynchronously
            // And the stream should be closed
            see(); await Promise.resolve(); await Promise.resolve(); see("42", "closed");
        });
    });
    describe("fromSignal()", () => {
        it("should output each value of the signal, including the first", () => {
            // Given a fromSignal(value())
            const v = value(42), s = fromSignal(v);
            // When it's subscribed
            connect(s, log.emit);
            // Then it should output the current value once effects+pulls run
            see(); runEffects(); runPulls(); see("42");
            // And output the latest current value on subsequent runs
            v.set(43); runPulls(); v.set(44);
            see(); runEffects(); runPulls(); see("44");
        });
        it("should not emit duplicate values", () => {
            // Given a fromSignal(func())
            const v1 = value(42), v2 = value(0);
            const f = () => v1() * v2(), s = fromSignal(f);
            // When it's subscribed
            connect(s, log.emit);
            // Then it should output the current value once effects+pulls run
            see(); runEffects(); runPulls(); see("0");
            // And should not output duplicates even if dependencies change
            v1.set(43); v1.set(44);
            see(); runEffects(); runPulls(); see();
            // But should still output changes to the result
            v2.set(1);
            see(); runEffects(); runPulls(); see("44");
        });
    });
    describe("fromSubscribe()", () => {
        it("should subscribe w/pusher on pull and unsub on close", () => {
            // Given a subscribe function
            let pusher: (v: any) => void;
            const unsub = spy(), subscribe = spy(cb  => ((pusher = cb), unsub));
            // And a fromSubscribe() source
            const s = fromSubscribe(subscribe);
            // When it's subscribed
            const c = connect(s, log.emit);
            // Then the subscribe function should not be called until resumed
            expect(subscribe).to.not.have.been.called;
            resume(c); runPulls();
            expect(subscribe).to.have.been.calledOnce;
            expect(pusher).to.be.a("function");
            // And calling the pusher should emit the value and return void
            expect(pusher(42)).to.be.undefined;
            see("42");
            // And the unsub function should be called on close
            expect(unsub).to.not.have.been.called;
            c.end();
            expect(unsub).to.have.been.calledOnce;
        });
    });
    describe("fromValue()", () => {
        it("should output the value, then close", () => {
            // Given a fromValue() stream
            const s = fromValue(42);
            // When it's subscribed
            connect(s, log.emit).must(logClose);
            // Then it should only output the value on the next tick
            // And close the connection
            see();
            runPulls();
            see("42", "closed")
        });
    });
    describe("interval", () => {
        useClock();
        it("emits 0-based numbers every N ms", () => {
            // Given an interval
            const s = interval(7);
            // When it's subscribed
            const c = connect(s, log.emit);
            // Then it should emit every N ms until stopped
            see();
            clock.tick(7);
            see("0");
            clock.tick(42);
            see("1", "2", "3", "4", "5", "6");
            c.end();
            clock.tick(100);
            see();
        });
    });
    describe("lazy()", () => {
        it("delegates to its factory's result on subscribe", () => {
            // Given a lazy()-wrapped factory
            const src = spy(), factory = spy(() => src);
            const s = lazy(factory);
            // When it's subscribed
            const c = connect(s, log.emit);
            // Then it should call the factory
            expect(factory).to.have.been.calledOnceWithExactly()
            // And pass the connection and sink to the result
            expect(src).to.have.been.calledOnceWithExactly(log.emit, c);
        });
    });
    describe("never()", () => {
        useClock();
        it("does nothing", () => {
            // Given a never() stream
            const s = never();
            // When subscribed
            const c = connect(s, log.emit).must(logClose);
            clock.tick(100);
            // Then nothing happens and the connection stays open
            see();
        });
    });
})