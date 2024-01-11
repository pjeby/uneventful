import { log, see, describe, expect, it, spy, useClock, clock, useRoot } from "./dev_deps.ts";
import { Conduit } from "../src/streams.ts";
import { runPulls } from "../src/scheduling.ts";
import { type Flow, IsStream, connect, Sink, Source, compose, pipe, must, detached, start, getFlow } from "../mod.ts";

function mkConduit(parent: Flow = null) {
    if (!parent) return detached.run(() => new Conduit());
    return new Conduit(parent);
}

function logClose() { log("closed"); }

describe("connect()", () => {
    useRoot();
    it("calls source with sink and returns a Conduit", () => {
        // Given a source and a sink
        const src = spy(), sink = spy();
        // When connect() is called with them
        const c = connect(src, sink);
        // Then you should get a conduit
        expect(c).to.be.an.instanceOf(Conduit);
        // And the source should have been called with the conduit and the sink
        expect(src).to.have.been.calledOnceWithExactly(sink, c);
    });
    it("is linked to the running flow", () => {
        // Given a conduit opened by connect in the context of a flow
        const src = spy(), sink = spy();
        const flow = start(() => {
            connect(src, sink).must(logClose);
        });
        // When the flow is ended
        see(); flow.end();
        // Then the conduit should be closed
        see("closed");
    });
    it("calls the source with the conduit's flow active", () => {
        // Given a source and a sink
        function sink() { return true; }
        function src(_sink: Sink<any>) { must(() => log("cleanup")); return IsStream; }
        // When connect() is called with them and closed
        connect(src, sink).close();
        // Then cleanups added by the source should be called
        see("cleanup");
    });
});

describe("Conduit", () => {
    it("initially isReady(), and not hasError()", () => {
        // Given a Conduit
        const c = mkConduit();
        // When its status is checked
        // Then it should be open and not have an error
        expect(c.isReady()).to.be.true;
        expect(c.hasError()).to.be.false;
        expect(c.hasUncaught()).to.be.false;
    });
    it(".hasError(), .hasUncaught(), and .reason when .throw()n", () => {
        // Given a conduit with a thrown error
        const e = new Error, c = mkConduit().throw(e);
        // When its status is checked
        // Then it should be closed and have an error
        expect(c.hasError()).to.be.true;
        expect(c.hasUncaught()).to.be.true;
        // And the reason should be the thrown error
        expect(c.reason).to.equal(e);
    });
    it("is closed(+unready) with no error when .close()d", () => {
        // Given a conduit that's closed
        const c = mkConduit().must(logClose).close();
        // When its status is checked
        // Then it should be closed and not have an error
        see("closed");
        expect(c.isReady()).to.be.false;
        expect(c.hasError()).to.be.false;
    });
    it("closes(+unready) when its enclosing flow is cleaned up", () => {
        // Given a flow and a conduit it's attached to
        detached.start(end => {
            const c = mkConduit(getFlow()).must(logClose);
            // When the flow ends
            end();
            // Then the conduit should be closed
            see("closed");
            expect(c.isReady()).to.be.false;
        });
    });
    describe("is inactive after closing:", () => {
        it("ignores close() if already thrown", () => {
            // Given a conduit with a thrown error
            const e = new Error, c = mkConduit().throw(e);
            // When it's close()d
            c.close();
            // Then it should still have its error and reason
            expect(c.hasError()).to.be.true;
            expect(c.reason).to.equal(e);
        });
        it("ignores throw() if already thrown", () => {
            // Given a conduit with a thrown error
            const e = new Error, c = mkConduit().throw(e);
            // When it's thrown again
            c.throw(new Error);
            // Then it should still have its original reason
            expect(c.reason).to.equal(e);
        });
        it("ignores throw() if already closed", () => {
            // Given a conduit that's closed
            const c = mkConduit().close();
            // When it's thrown
            c.throw(new Error);
            // Then it should not have an error
            expect(c.hasError()).to.be.false;
        });
        it("won't fork() or link()", () => {
            // Given a closed conduit
            const c = mkConduit().close();
            // When fork() or link() is called
            // Then an error should be thrown
            expect(() => c.fork()).to.throw("Can't fork or link a closed conduit");
            expect(() => c.link()).to.throw("Can't fork or link a closed conduit");
        });
    });
    describe("runs .must() callbacks synchronously in LIFO order", () => {
        it("when close()d", () => {
            // Given a conduit with two must callbacks
            const c = mkConduit().must(() => log("first")).must(() => log("last"));
            // When the conduit is closed
            c.close();
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("when thrown()", () => {
            // Given a conduit with two must callbacks
            const c = mkConduit().must(() => log("first")).must(() => log("last"));
            // When the conduit is thrown()
            c.throw(new Error);
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("with the error state known", () => {
            // Given a conduit with a must callback
            const c = mkConduit().must(() => { log(c.hasError()); log(c.reason); });
            // When the conduit is thrown()
            c.throw("this is the reason")
            // Then the callback should see the correct error state
            see("true", "this is the reason");
        });
        it("when the enclosing flow is cleaned up", () => {
            // Given a flow and a conduit it's attached to
            detached.start(end => {
                const c = mkConduit(getFlow());
                // And two must callbacks
                c.must(() => log("first")).must(() => log("last"));
                // When the flow is cleaned up
                end();
                // Then the callbacks should be run in reverse order
                see("last", "first");
            });
        });
    });
    describe("runs .must() callbacks asynchronously in LIFO order", () => {
        useClock();
        it("when already close()d", () => {
            // Given a closed conduit
            const c = mkConduit().close();
            // When must() is called with two new callbacks
            c.must(() => log("first")).must(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("last", "first");
        });
        it("when already throw()n", () => {
            // Given a thrown conduit
            const c = mkConduit().throw(new Error);
            // When must() is called with two new callbacks
            c.must(() => log("first")).must(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("last", "first");
        });
        it("while other .must callbacks are running", () => {
            // Given a conduit with two must callbacks, one of which calls a third
            const c = mkConduit()
                .must(() => log("first"))
                .must(() => c.must(() => log("last")));
            // When the conduit is closed
            c.close();
            // Then the newly-added callback should run immediately
            see("last", "first");
        });
    });
    describe(".isReady()", () => {
        it("is false after pause(), true after resume() (if open)", () => {
            // Given a conduit
            const c = mkConduit()
            // When it's paused, Then it shoud be unready
            c.pause(); expect(c.isReady()).to.be.false;
            // And when resumed it should be ready again
            c.resume(); expect(c.isReady()).to.be.true;
            // Unless it's closed
            c.close(); expect(c.isReady()).to.be.false;
            // In which case it should not be resumable
            c.resume(); expect(c.isReady()).to.be.false;
        });
    });
    describe(".catch()", () => {
        it("prevents hasUncaught() before the fact", () => {
            // Given a conduit with .catch() called
            const e = new Error, c = mkConduit().catch();
            // When the conduit is thrown
            c.throw(e);
            // Then it should be considered caught
            expect(c.hasError()).to.be.true;
            expect(c.hasUncaught()).to.be.false;
        });
        it("resets hasUncaught() after the fact", () => {
            // Given a conduit with a thrown error
            const e = new Error, c = mkConduit().throw(e);
            // Then it should be uncaught
            expect(c.hasUncaught()).to.be.true;
            // Until catch() is called
            c.catch();
            // Then it should no longer be uncaught
            expect(c.hasUncaught()).to.be.false;
        });
        it("invokes its callback with the reason and connection", () => {
            // Given a conduit with a .catch callback
            const e = new Error, cb = spy(), c = mkConduit().catch(cb);
            // When the conduit is thrown
            c.throw(e);
            // Then it should be considered caught
            expect(c.hasError()).to.be.true;
            expect(c.hasUncaught()).to.be.false;
            // And the callback should have been called with the reason and conduit
            expect(cb).to.have.been.calledOnceWithExactly(e, c);
        });
    });
    function verifyWrite(makeWriter: <T>(c: Conduit, cb: Sink<T>) => (val: T) => boolean) {
        it("does nothing if the conduit is closed", () => {
            // Given a writer of a closed conduit
            const c = mkConduit(), w = makeWriter(c, v => { log(v); return true; });
            c.close();
            // When the writer is called
            const res = w(42);
            // Then it returns false
            expect(res).to.be.false;
            // And the sink is not invoked
            see();
        });
        it("calls the sink and returns the ready state", () => {
            // Given a conduit and its writer()
            let ret = true;
            const c = mkConduit(), cb = spy(() => ret);
            const w = makeWriter(c, cb);
            // When the writer is called
            // Then it returns the conduit's ready state
            expect(w(42)).to.be.true;
            c.pause();
            expect(w(43)).to.be.false;
            // And the sink is invoked with the value
            expect(cb).to.have.been.calledTwice;
            expect(cb).to.have.been.calledWithExactly(42);
            expect(cb).to.have.been.calledWithExactly(43);
        });
        it("traps errors and throws them", () => {
            // Given a conduit and a writer that throws
            const c = mkConduit(), e = new Error, w = makeWriter(c, cb);
            function cb() { throw e; return true; }
            // When the writer is called
            const res = w(42);
            // Then false is returned and the conduit enters a thrown state
            expect(res).to.be.false;
            expect(c.hasError()).to.be.true;
            expect(c.reason).to.equal(e);
        });
    }
    describe(".writer() returns a value-taking function that", () => {
        verifyWrite((c, cb) => c.writer(cb));
    });
    describe(".push()", () => {
        verifyWrite((c, cb) => (val) => c.push(cb, val));
    });
    describe(".resume()", () => {
        let c: Conduit;
        beforeEach(() => {
            // Given a paused conduit with an onReady
            c = mkConduit().pause().onReady(() => log("resumed"));
        });
        describe("does nothing if", () => {
            it("conduit is already closed", () => {
                // Given a paused conduit with an onReady
                // When the conduit is closed and resume()ed
                see(); c.close(); c.resume();
                // Then the callback is not invoked
                runPulls(); see();
            });
            it("no onReady() is set", () => {
                // Given a conduit without an onReady
                c = mkConduit();
                // When the conduit is resume()d
                c.resume();
                // Then nothing happens
                runPulls();
                see();
            });
            it("after the onReady() was used", () => {
                // Given a paused conduit with an onReady
                // When the conduit is resume()d twice
                // Then nothing should happen the second time
                c.resume(); runPulls(); see("resumed");
                c.resume(); runPulls(); see();
            });
        });
        it("synchronously runs callbacks", () => {
            // Given a paused conduit with an onReady
            // When the conduit is resume()d
            // Then the onReady callback should be invoked
            c.resume(); see("resumed");
            // And When a new onReady() is set
            c.onReady(() => log("resumed again"));
            // Then the new callback should be invoked asynchronously
            see(); // but not synchronously
            runPulls(); see("resumed again");
        });
        it("doesn't run duplicate onReady callbacks", () => {
            // Given a paused conduit with added duplicate functions
            const c = mkConduit().pause(), f1 = () => { log("f1"); }, f2 = () => { log("f2"); };
            c.onReady(f1).onReady(f2).onReady(f1).onReady(f2);
            // When the conduit is resumed
            c.resume();
            // Then it should run each function only once
            see("f1", "f2");
        });
    });

    function testChildConduit(mkChild: <T>(c: Conduit, src?: Source<T>, sink?: Sink<T>) => Conduit) {
        it("is open", () => {
            // Given a conduit and its child
            const c = mkConduit(), f = mkChild(c).must(logClose);
            // Then the link should be open and not equal the conduit
            see();
            expect(f).to.not.equal(c);
        });
        it("closes when the parent closes", () => {
            // Given a conduit and its child
            const c = mkConduit(), f = mkChild(c).must(logClose);
            // When the conduit is closed
            c.close();
            // Then the link should also be closed
            see("closed");
        });
        it("closes when the parent is thrown", () => {
            // Given a conduit and its child
            const c = mkConduit(), f = mkChild(c).must(logClose);
            // When the conduit is thrown
            c.throw(new Error);
            // Then the link should be closed without error
            see("closed");
            expect(f.hasError()).to.be.false;
        });
        it("subscribes a source if given one", () => {
            // Given a conduit, a source, and a sink
            const c = mkConduit(), src = spy(), sink = spy();
            // When the conduit is forked/linked
            const f = mkChild(c, src, sink);
            // Then the source should be called with the new conduit and the sink
            expect(src).to.have.been.calledOnceWithExactly(sink, f);
        });
        it("runs with the new conduit's flow", () => {
            // Given a conduit, a source and a sink
            const c = mkConduit();
            function sink() { return true; }
            function src() { must(() => log("cleanup")); return IsStream; }
            // When the conduit is forked/linked and closed
            mkChild(c, src, sink).close();
            // Then cleanups added by the source should be called
            see("cleanup");
        });
    }
    describe(".fork() returns a conduit that", () => {
        testChildConduit((c, src?, sink?) => c.fork(src, sink));
    });
    describe(".link() returns a conduit that", () => {
        testChildConduit((c, src?, sink?) => c.link(src, sink));
        it("throws to its parent when throw()n", () => {
            // Given a conduit and its link()ed child
            const c = mkConduit(), f = c.link(), e = new Error;
            // When the child is thrown
            f.throw(e);
            // Then it and its parent should have the same error
            expect(f.hasError()).to.be.true;
            expect(c.hasError()).to.be.true;
            expect(f.reason).to.equal(e);
            expect(c.reason).to.equal(e);
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
