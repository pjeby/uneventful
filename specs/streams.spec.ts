import { log, see, describe, expect, it, spy, useRoot } from "./dev_deps.ts";
import { Connection, Connector, backpressure, pause, resume, subconnect } from "../src/streams.ts";
import { runPulls } from "../src/scheduling.ts";
import { type Job, IsStream, connect, Sink, Source, compose, pipe, must, detached, start, getJob, isError, JobResult, noop } from "../mod.ts";

type Conn = Connector & Connection;
function mkConn(parent: Job = null) {
    return (parent || detached).run(() => connect());
}

function logClose(e: JobResult<void>) { log("closed"); if (isError(e)) log(`err: ${e.err}`)}

describe("connect()", () => {
    useRoot();
    it("calls source with sink and returns a Connector", () => {
        // Given a source and a sink
        const src = spy(), sink = spy();
        // When connect() is called with them
        const c = connect(src, sink);
        // Then the source should have been called with the sink and connector
        expect(src).to.have.been.calledOnceWithExactly(sink, c);
    });
    it("is linked to the running job", () => {
        // Given a conduit opened by connect in the context of a job
        const src = spy(), sink = spy();
        const job = start(() => {
            connect(src, sink).must(logClose);
        });
        // When the job is ended
        see(); job.end();
        // Then the conduit should be closed
        see("closed");
    });
    it("calls the source with the conduit's job active", () => {
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
    useRoot();
    it("initially is ready", () => {
        // Given a ready function
        const ready = backpressure(mkConn());
        // Then it should be ready
        expect(ready()).to.be.true;
    });
    it("is unready when connection is ended", () => {
        // Given an ended connection
        const c = mkConn().must(logClose); c.end();
        // When its status is checked
        // Then it should be closed and not have an error
        see("closed");
        expect(backpressure(c)()).to.be.false;
    });
    it("closes(+unready) when its enclosing job is cleaned up", () => {
        // Given a job and a connection it's attached to
        detached.start(job => {
            const c = mkConn(getJob()).must(logClose);
            // When the job ends
            job.end();
            // Then the connection should be closed and the limiter unready
            see("closed");
            expect(backpressure(c)()).to.be.false;
        });
    });

    describe(".isReady()", () => {
        it("is false after pause(), true after resume() (if open)", () => {
            // Given a conduit
            const c = mkConn()
            // When it's paused, Then it shoud be unready
            pause(c); expect(backpressure(c)()).to.be.false;
            // And when resumed it should be ready again
            resume(c); expect(backpressure(c)()).to.be.true;
            // Unless it's closed
            c.end(); expect(backpressure(c)()).to.be.false;
            // In which case it should not be resumable
            resume(c); expect(backpressure(c)()).to.be.false;
        });
    });

    describe(".resume()", () => {
        let c: Conn;
        beforeEach(() => {
            // Given a paused conduit with an onReady
            c = mkConn(); pause(c); backpressure(c)(() => log("resumed"));
        });
        describe("does nothing if", () => {
            it("conduit is already closed", () => {
                // Given a paused conduit with an onReady
                // When the conduit is closed and resume()ed
                see(); c.end(); resume(c);
                // Then the callback is not invoked
                runPulls(); see();
            });
            it("no onReady() is set", () => {
                // Given a conduit without an onReady
                c = mkConn();
                // When the conduit is resume()d
                resume(c);
                // Then nothing happens
                runPulls();
                see();
            });
            it("after the onReady() was used", () => {
                // Given a paused conduit with an onReady
                // When the conduit is resume()d twice
                // Then nothing should happen the second time
                resume(c); runPulls(); see("resumed");
                resume(c); runPulls(); see();
            });
        });
        it("synchronously runs callbacks", () => {
            // Given a paused conduit with an onReady
            // When the conduit is resume()d
            // Then the onReady callback should be invoked
            resume(c); see("resumed");
            // And When a new onReady() is set
            backpressure(c)(() => log("resumed again"));
            // Then the new callback should be invoked asynchronously
            see(); // but not synchronously
            runPulls(); see("resumed again");
        });
        it("doesn't run duplicate onReady callbacks", () => {
            // Given a paused conduit with added duplicate functions
            const c = mkConn(); pause(c); const f1 = () => { log("f1"); }, f2 = () => { log("f2"); };
            const r = backpressure(c); r(f1); r(f2); r(f1); r(f2);
            // When the conduit is resumed
            resume(c);
            // Then it should run each function only once
            see("f1", "f2");
        });
    });
});

describe("subconnect()", () => {
    it("won't work on a closed connection", () => {
        // Given a closed conduit
        const c = mkConn(); c.end();
        // When fork() or link() is called
        // Then an error should be thrown
        expect(() => subconnect(c, () => IsStream, noop)).to.throw("Can't fork or link a closed conduit");
    });

    describe("returns a conduit that", () => {
        testChildConduit((c, src?, sink?) => subconnect(c, src, sink));
        it("throws to its parent when throw()n", () => {
            // Given a conduit and its link()ed child
            const c = mkConn(), f = subconnect(c, () => IsStream, noop), e = new Error("x");
            c.must(e => { log("c"); logClose(e); });
            f.must(e => { log("f"); logClose(e); });
            // When the child is thrown
            f.throw(e);
            // Then it and its parent should have the same error
            see("f", "closed", "err: Error: x", "c", "closed", "err: Error: x");
        });
    });

    function testChildConduit(mkChild: <T>(c: Connection, src?: Source<T>, sink?: Sink<T>) => Connector) {
        it("is open", () => {
            // Given a conduit and its child
            const c = mkConn(), f = mkChild(c).must(logClose);
            // Then the link should be open and not equal the conduit
            see();
            expect(f).to.not.equal(c);
        });
        it("closes when the parent closes", () => {
            // Given a conduit and its child
            const c = mkConn(), f = mkChild(c).must(logClose);
            // When the conduit is closed
            c.end();
            // Then the link should also be closed
            see("closed");
        });
        it("closes when the parent is thrown", () => {
            // Given a conduit and its child
            const c = mkConn(), f = mkChild(c).must(logClose);
            // When the conduit is thrown
            c.throw(new Error);
            // Then the link should be closed without error
            see("closed");
        });
        it("subscribes a source if given one", () => {
            // Given a conduit, a source, and a sink
            const c = mkConn(), src = spy(), sink = spy();
            // When the conduit is forked/linked
            const f = mkChild(c, src, sink);
            // Then the source should be called with the new conduit and the sink
            expect(src).to.have.been.calledOnceWithExactly(sink, f);
        });
        it("runs with the new conduit's job", () => {
            // Given a conduit, a source and a sink
            const c = mkConn();
            function sink() { return true; }
            function src() { must(() => log("cleanup")); return IsStream; }
            // When the conduit is forked/linked and closed
            mkChild(c, src, sink).end();
            // Then cleanups added by the source should be called
            see("cleanup");
        });
    }
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
