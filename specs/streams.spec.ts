import { log, see, describe, expect, it, spy, useContext } from "./dev_deps.ts";
import { Throttle, backpressure, throttle } from "../src/streams.ts";
import { runPulls } from "./dev_deps.ts";
import { IsStream, connect, Sink, compose, pipe, must, start, isError, Result, root, Context, starting, Work } from "../src/mod.ts";

function logClose(e: Result<void>) { log("closed"); if (isError(e)) log(`err: ${e.err}`)}

describe("connect()", () => {
    useContext();
    it("calls source with sink and returns a Connector", () => {
        // Given a source and a sink
        const src = spy(), sink = spy();
        // When connect() is called with them
        const c = connect(src, sink);
        // Then the source should have been called with the sink and connector
        expect(src).to.have.been.calledOnceWithExactly(sink, c, undefined);
    });
    it("is linked to the running context", () => {
        // Given a connection opened by connect in the context of a task
        const src = spy(), sink = spy();
        const task = start(() => {
            connect(src, sink).do(logClose);
        });
        // When the task is ended
        see(); task.end();
        // Then the connection should be closed
        see("closed");
    });
    it("calls the source with the connection's Work context active", () => {
        // Given a source and a sink
        function sink() { return true; }
        function src(_sink: Sink<any>) { must(() => log("cleanup")); return IsStream; }
        // When connect() is called with them and closed
        connect(src, sink).end();
        // Then cleanups added by the source should be called
        see("cleanup");
    });
});

describe("backpressure()", () => {
    useContext();
    it("initially is ready", () => {
        // Given a ready function
        const ready = backpressure(throttle(starting<void>()));
        // Then it should be ready
        expect(ready()).to.be.true;
    });
    it("is unready when connection is ended", () => {
        // Given an ended connection
        const c = starting<void>(); c.task().do(logClose).end();
        // When its status is checked
        // Then it should be closed and not have an error
        see("closed");
        expect(backpressure(throttle(c))()).to.be.false;
    });
    it("closes(+unready) when its enclosing context is cleaned up", () => {
        // Given a task and a connection it's attached to
        root.start(work => {
            const c = starting<void>(); c.task().do(logClose);
            // When the task ends
            work.end();
            // Then the connection should be closed and the limiter unready
            see("closed");
            expect(backpressure(throttle(c))()).to.be.false;
        });
    });

    describe(".isReady()", () => {
        it("is false after pause(), true after resume() (if open)", () => {
            // Given a connection and throttle
            const c = starting<void>(), t = throttle(c), ready = backpressure(t);
            // When it's paused, Then it shoud be unready
            t.pause(); expect(ready()).to.be.false;
            // And when resumed it should be ready again
            t.resume(); expect(ready()).to.be.true;
            // Unless it's closed
            c.end(); expect(ready()).to.be.false;
            // In which case it should not be resumable
            t.resume(); expect(ready()).to.be.false;
        });
    });

    describe(".resume()", () => {
        let c: Work, t: Throttle;
        beforeEach(() => {
            // Given a paused connection with an onReady
            c = starting<void>(); t = throttle(c); t.pause(); backpressure(t)(() => log("resumed"));
        });
        describe("does nothing if", () => {
            it("connection is already closed", () => {
                // Given a paused connection with an onReady
                // When the connection is closed and resume()ed
                see(); c.end(); t.resume();
                // Then the callback is not invoked
                runPulls(); see();
            });
            it("no onReady() is set", () => {
                // Given a connection without an onReady
                c = starting<void>(); t = throttle(c); t.pause();
                // When the connection is resume()d
                t.resume();
                // Then nothing happens
                runPulls();
                see();
            });
            it("after the onReady() was used", () => {
                // Given a paused connection with an onReady
                // When the connection is resume()d twice
                // Then nothing should happen the second time
                t.resume(); runPulls(); see("resumed");
                t.resume(); runPulls(); see();
            });
        });
        it("synchronously runs callbacks", () => {
            // Given a paused connection with an onReady
            // When the connection is resume()d
            // Then the onReady callback should be invoked
            t.resume(); see("resumed");
            // And When a new onReady() is set
            backpressure(t)(() => log("resumed again"));
            // Then the new callback should be invoked asynchronously
            see(); // but not synchronously
            runPulls(); see("resumed again");
        });
        it("doesn't run duplicate onReady callbacks", () => {
            // Given a paused connection with added duplicate functions
            const c = starting<void>(), t = throttle(); t.pause(); const f1 = () => { log("f1"); }, f2 = () => { log("f2"); };
            const r = backpressure(t); r(f1); r(f2); r(f1); r(f2);
            // When the connection is resumed
            t.resume();
            // Then it should run each function only once
            see("f1", "f2");
        });
    });
});

describe("pipe()", () => {
    it("with one argument, returns it", () => {
        expect(pipe(42)).to.equal(42);
    });
    it("with two arguments, passes the first to the second", () => {
        expect(pipe(42, x => x+1)).to.equal(43);
    });
    it("with three arguments, chains", () => {
        expect(pipe(42, x => x+1, JSON.stringify)).to.equal("43");
    });
});

describe("compose()", () => {
    it("with no arguments, returns an identity function", () => {
        expect(compose()(42)).to.equal(42);
    });
    it("with one argument, returns an equivalent function", () => {
        expect(compose((x:number) => x+1)(42)).to.equal(43);
    });
    it("with two arguments, chains", () => {
        expect(compose((x: number) => x+1, JSON.stringify)(42)).to.equal("43");
    });
});
