import { log, see, describe, expect, it, spy, useClock, clock, useRoot } from "./dev_deps.ts";
import { Conduit, runPulls } from "../src/streams.ts";
import { type Flow, connect, Sink, Source, compose, pipe, onCleanup, detached, makeFlow } from "../mod.ts";

function mkConduit(parent: Flow = null) {
    if (!parent) return detached(() => new Conduit())();
    return new Conduit(parent);
}

describe("connect()", () => {
    useRoot();
    it("calls source with sink and returns a Conduit", () => {
        // Given a source and a sink
        const t = makeFlow(), src = spy(), sink = spy();
        // When connect() is called with them
        const c = t.run(connect, src, sink);
        // Then you should get a conduit
        expect(c).to.be.an.instanceOf(Conduit);
        // And the source should have been called with the conduit and the sink
        expect(src).to.have.been.calledOnceWithExactly(c, sink);
    });
    it("is linked to the running flow", () => {
        // Given a conduit opened by connect in the context of a flow
        const f = makeFlow(), src = spy(), sink = spy();
        const c = f.run(connect, src, sink);
        // When the flow is cleaned up
        f.cleanup();
        // Then the conduit should be closed
        expect(c.isOpen()).to.be.false;
    });
    it("calls the source with the conduit's flow active", () => {
        // Given a source and a sink
        function sink() { return true; }
        function src(conn: Conduit) { onCleanup(() => log("cleanup")); return conn; }
        // When connect() is called with them and closed
        connect(src, sink).close();
        // Then cleanups added by the source should be called
        see("cleanup");
    });
});

describe("Conduit", () => {
    it("initially isOpen(), isReady(), and not hasError()", () => {
        // Given a Conduit
        const c = mkConduit();
        // When its status is checked
        // Then it should be open and not have an error
        expect(c.isOpen()).to.be.true;
        expect(c.isReady()).to.be.true;
        expect(c.hasError()).to.be.false;
        expect(c.hasUncaught()).to.be.false;
    });
    it(".hasError(), .hasUncaught(), and .reason when .throw()n", () => {
        // Given a conduit with a thrown error
        const e = new Error, c = mkConduit().throw(e);
        // When its status is checked
        // Then it should be closed and have an error
        expect(c.isOpen()).to.be.false;
        expect(c.hasError()).to.be.true;
        expect(c.hasUncaught()).to.be.true;
        // And the reason should be the thrown error
        expect(c.reason).to.equal(e);
    });
    it("is closed(+unready) with no error when .close()d", () => {
        // Given a conduit that's closed
        const c = mkConduit().close();
        // When its status is checked
        // Then it should be closed and not have an error
        expect(c.isOpen()).to.be.false;
        expect(c.isReady()).to.be.false;
        expect(c.hasError()).to.be.false;
    });
    it("closes(+unready) when its enclosing flow is cleaned up", () => {
        // Given a flow and a conduit it's attached to
        const t = makeFlow(), c = mkConduit(t);
        expect(c.isOpen()).to.be.true;
        // When the flow is cleaned up
        t.cleanup();
        // Then the conduit should be closed
        expect(c.isOpen()).to.be.false;
        expect(c.isReady()).to.be.false;
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
    describe("runs .onCleanup() callbacks synchronously in LIFO order", () => {
        it("when close()d", () => {
            // Given a conduit with two onCleanup callbacks
            const c = mkConduit().onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the conduit is closed
            c.close();
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("when thrown()", () => {
            // Given a conduit with two onCleanup callbacks
            const c = mkConduit().onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the conduit is thrown()
            c.throw(new Error);
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("with the error state known", () => {
            // Given a conduit with an onCleanup callback
            const c = mkConduit().onCleanup(() => { log(c.hasError()); log(c.reason); });
            // When the conduit is thrown()
            c.throw("this is the reason")
            // Then the callback should see the correct error state
            see("true", "this is the reason");
        });
        it("when the enclosing flow is cleaned up", () => {
            // Given a flow and a conduit it's attached to
            const f = makeFlow(), c = mkConduit(f);
            // And two onCleanup callbacks
            c.onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the flow is cleaned up
            f.cleanup();
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
    });
    describe("runs .onCleanup() callbacks asynchronously in FIFO order", () => {
        useClock();
        it("when already close()d", () => {
            // Given a closed conduit
            const c = mkConduit().close();
            // When onCleanup() is called with two new callbacks
            c.onCleanup(() => log("first")).onCleanup(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("first", "last");
        });
        it("when already throw()n", () => {
            // Given a thrown conduit
            const c = mkConduit().throw(new Error);
            // When onCleanup() is called with two new callbacks
            c.onCleanup(() => log("first")).onCleanup(() => log("last"))
            // Then they should not be run
            see()
            // Until the next microtask
            clock.tick(0);
            see("first", "last");
        });
        it("while other .onCleanup callbacks are running", () => {
            // Given a conduit with two onCleanup callbacks, one of which calls a third
            const c = mkConduit()
                .onCleanup(() => log("first"))
                .onCleanup(() => c.onCleanup(() => log("last")));
            // When the conduit is closed
            c.close();
            // Then the initial callbacks should be run in reverse order,
            see("first");
            // but the newly-pushed callback should run asynchronously
            clock.tick(0);
            see("last");
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
        it("calls the sink and returns its return value", () => {
            // Given a conduit and its writer()
            let ret = true;
            const c = mkConduit(), cb = spy(() => ret);
            const w = makeWriter(c, cb);
            // When the writer is called
            // Then it returns the sink's return value
            expect(w(42)).to.be.true;
            ret = false;
            expect(w(43)).to.be.false;
            // And the sink is invoked with the value and conduit
            expect(cb).to.have.been.calledTwice;
            expect(cb).to.have.been.calledWithExactly(42, c);
            expect(cb).to.have.been.calledWithExactly(43, c);
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
            const c = mkConduit(), f = mkChild(c);
            // Then the link should be open and not the conduit
            expect(f).to.not.equal(c);
            expect(f.isOpen()).to.be.true;
        });
        it("closes when the parent closes", () => {
            // Given a conduit and its child
            const c = mkConduit(), f = mkChild(c);
            // When the conduit is closed
            c.close();
            // Then the link should also be closed
            expect(f.isOpen()).to.be.false;
        });
        it("closes when the parent is thrown", () => {
            // Given a conduit and its child
            const c = mkConduit(), f = mkChild(c);
            // When the conduit is thrown
            c.throw(new Error);
            // Then the link should be closed without error
            expect(f.isOpen()).to.be.false;
            expect(f.hasError()).to.be.false;
        });
        it("subscribes a source if given one", () => {
            // Given a conduit, a source, and a sink
            const c = mkConduit(), src = spy(), sink = spy();
            // When the conduit is forked/linked
            const f = mkChild(c, src, sink);
            // Then the source should be called with the new conduit and the sink
            expect(src).to.have.been.calledOnceWithExactly(f, sink);
        });
        it("runs with the new conduit's flow", () => {
            // Given a conduit, a source and a sink
            const c = mkConduit();
            function sink() { return true; }
            function src(conn: Conduit) { onCleanup(() => log("cleanup")); return conn; }
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
