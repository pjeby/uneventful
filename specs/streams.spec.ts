import { log, see, describe, expect, it, spy, useClock, clock } from "./dev_deps.ts";
import { Conduit } from "../src/streams.ts";
import { tracker, connect, Sink, Source, compose, pipe } from "../mod.ts";

describe("connect()", () => {
    it("calls source with sink and returns a Conduit", () => {
        // Given a source and a sink
        const t = tracker(), src = spy(), sink = spy();
        // When connect() is called with them
        const c = t.run(connect, src, sink);
        // Then you should get a conduit
        expect(c).to.be.an.instanceOf(Conduit);
        // And the source should have been called with the conduit and the sink
        expect(src).to.have.been.calledOnceWithExactly(c, sink);
    });
    it("can be invoked with an explicit null tracker", () => {
        // Given a source and a sink
        const src = spy(), sink = spy();
        // When connect() is called with them and a null tracker
        const c = connect(src, sink, null);
        // Then you should get a conduit
        expect(c).to.be.an.instanceOf(Conduit);
        // And the source should have been called with the conduit and the sink
        expect(src).to.have.been.calledOnceWithExactly(c, sink);
    })
    it("can be linked to a specific tracker", () => {
        // Given a conduit opened by connect with a specific tracker
        const t = tracker(), src = spy(), sink = spy();
        const c = connect(src, sink, t);
        // When the tracker is cleaned up
        t.cleanup();
        // Then the conduit should be closed
        expect(c.isOpen()).to.be.false;
    });
    it("is linked to the running tracker by default", () => {
        // Given a conduit opened by connect in the context of a tracker
        const t = tracker(), src = spy(), sink = spy();
        const c = t.run(connect, src, sink);
        // When the tracker is cleaned up
        t.cleanup();
        // Then the conduit should be closed
        expect(c.isOpen()).to.be.false;
    });
});

describe("Conduit", () => {
    it("initially isOpen() and not hasError()", () => {
        // Given a new Conduit
        const c = new Conduit;
        // When its status is checked
        // Then it should be open and not have an error
        expect(c.isOpen()).to.be.true;
        expect(c.hasError()).to.be.false;
    });
    it(".hasError() and .reason when .throw()n", () => {
        // Given a conduit with a thrown error
        const e = new Error, c = new Conduit().throw(e);
        // When its status is checked
        // Then it should be closed and have an error
        expect(c.isOpen()).to.be.false;
        expect(c.hasError()).to.be.true;
        // And the reason should be the thrown error
        expect(c.reason).to.equal(e);
    });
    it("is closed with no error when .close()d", () => {
        // Given a conduit that's closed
        const c = new Conduit().close();
        // When its status is checked
        // Then it should be closed and not have an error
        expect(c.isOpen()).to.be.false;
        expect(c.hasError()).to.be.false;
    });
    it("closes when its enclosing tracker is cleaned up", () => {
        // Given a tracker and a conduit it's attached to
        const t = tracker(), c = new Conduit(t);
        expect(c.isOpen()).to.be.true;
        // When the tracker is cleaned up
        t.cleanup();
        // Then the conduit should be closed
        expect(c.isOpen()).to.be.false;
    });
    describe("is inactive after closing:", () => {
        it("ignores close() if already thrown", () => {
            // Given a conduit with a thrown error
            const e = new Error, c = new Conduit().throw(e);
            // When it's close()d
            c.close();
            // Then it should still have its error and reason
            expect(c.hasError()).to.be.true;
            expect(c.reason).to.equal(e);
        });
        it("ignores throw() if already thrown", () => {
            // Given a conduit with a thrown error
            const e = new Error, c = new Conduit().throw(e);
            // When it's thrown again
            c.throw(new Error);
            // Then it should still have its original reason
            expect(c.reason).to.equal(e);
        });
        it("ignores throw() if already closed", () => {
            // Given a conduit that's closed
            const c = new Conduit().close();
            // When it's thrown
            c.throw(new Error);
            // Then it should not have an error
            expect(c.hasError()).to.be.false;
        });
        it("won't fork() or link()", () => {
            // Given a closed conduit
            const c = new Conduit().close();
            // When fork() or link() is called
            // Then an error should be thrown
            expect(() => c.fork()).to.throw("Can't fork or link a closed conduit");
            expect(() => c.link()).to.throw("Can't fork or link a closed conduit");
        });
    });
    describe("runs .onCleanup() callbacks synchronously in LIFO order", () => {
        it("when close()d", () => {
            // Given a conduit with two onCleanup callbacks
            const c = new Conduit().onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the conduit is closed
            c.close();
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("when thrown()", () => {
            // Given a conduit with two onCleanup callbacks
            const c = new Conduit().onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the conduit is thrown()
            c.throw(new Error);
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
        it("with the error state known", () => {
            // Given a conduit with an onCleanup callback
            const c = new Conduit().onCleanup(() => { log(c.hasError()); log(c.reason); });
            // When the conduit is thrown()
            c.throw("this is the reason")
            // Then the callback should see the correct error state
            see("true", "this is the reason");
        });
        it("when the enclosing tracker is cleaned up", () => {
            // Given a tracker and a conduit it's attached to
            const t = tracker(), c = new Conduit(t);
            // And two onCleanup callbacks
            c.onCleanup(() => log("first")).onCleanup(() => log("last"));
            // When the tracker is cleaned up
            t.cleanup();
            // Then the callbacks should be run in reverse order
            see("last", "first");
        });
    });
    describe("runs .onCleanup() callbacks asynchronously in FIFO order", () => {
        useClock();
        it("when already close()d", () => {
            // Given a closed conduit
            const c = new Conduit().close();
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
            const c = new Conduit().throw(new Error);
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
            const c = new Conduit()
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
    function verifyWrite(makeWriter: <T>(c: Conduit, cb: Sink<T>) => (val: T) => boolean) {
        it("does nothing if the conduit is closed", () => {
            // Given a writer of a closed conduit
            const c = new Conduit(), w = makeWriter(c, v => { log(v); return true; });
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
            const c = new Conduit(), cb = spy(() => ret);
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
            const c = new Conduit, e = new Error, w = makeWriter(c, cb);
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
    describe(".pull()", () => {
        let c: Conduit;
        beforeEach(() => {
            c = new Conduit().onPull(() => log("pulled"));
        });
        useClock();
        describe("does nothing if", () => {
            it("conduit is already closed", () => {
                // Given a conduit with an onPull
                // When the conduit is closed and pull()ed
                c.close().pull();
                // Then the callback is not invoked
                clock.tick(0);
                see();
            });
            it("conduit is closed after the pull", () => {
                // Given a conduit with an onPull
                // When the conduit is pull()ed and closed
                c.pull().close();
                // Then the callback is not invoked
                clock.tick(0);
                see();
            });
            it("no onPull() is set", () => {
                // Given a conduit without an onPull
                c = new Conduit;
                // When the conduit is pulled()
                c.pull();
                // Then nothing happens
                clock.tick(0);
                see();
            });
            it("the onPull() is cleared", () => {
                // Given a conduit with an onPull
                // When onPull() is called with no arguments before pull()
                c.onPull().pull();
                // Then nothing happens
                clock.tick(0);
                see();
            });
            it("after the onPull() was used", () => {
                // Given a conduit with an onPull
                // When the conduit is pull()ed twice
                c.pull();
                clock.tick(0);
                see("pulled");
                c.pull();
                // Then nothing should happen the second time
                clock.tick(0);
                see();
            });
        });
        it("asynchronously calls the latest onPull() callback", () => {
            // Given a conduit with an onPull
            // When the conduit is pull()ed
            c.pull();
            // Then the onPull callback should be invoked asynchronously
            see(); // but not synchronously
            clock.tick(0);
            see("pulled");
            // And When a new onPull() is set and pull()ed
            c.onPull(() => log("pulled again"));
            c.pull();
            // Then the new onPull callback should be invoked asynchronously
            see(); // but not synchronously
            clock.tick(0);
            see("pulled again");
        });
    });

    function testChildConduit(mkChild: <T>(c: Conduit, src?: Source<T>, sink?: Sink<T>) => Conduit) {
        it("is open", () => {
            // Given a conduit and its child
            const c = new Conduit, f = mkChild(c);
            // Then the link should be open and not the conduit
            expect(f).to.not.equal(c);
            expect(f.isOpen()).to.be.true;
        });
        it("closes when the parent closes", () => {
            // Given a conduit and its child
            const c = new Conduit, f = mkChild(c);
            // When the conduit is closed
            c.close();
            // Then the link should also be closed
            expect(f.isOpen()).to.be.false;
        });
        it("closes when the parent is thrown", () => {
            // Given a conduit and its child
            const c = new Conduit, f = mkChild(c);
            // When the conduit is thrown
            c.throw(new Error);
            // Then the link should be closed without error
            expect(f.isOpen()).to.be.false;
            expect(f.hasError()).to.be.false;
        });
        it("subscribes a source if given one", () => {
            // Given a conduit, a source, and a sink
            const c = new Conduit, src = spy(), sink = spy();
            // When the conduit is forked/linked
            const f = mkChild(c, src, sink);
            // Then the source should be called with the new conduit and the sink
            expect(src).to.have.been.calledOnceWithExactly(f, sink);
        });
    }
    describe(".fork() returns a conduit that", () => {
        testChildConduit((c, src?, sink?) => c.fork(src, sink));
    });
    describe(".link() returns a conduit that", () => {
        testChildConduit((c, src?, sink?) => c.link(src, sink));
        it("throws to its parent when throw()n", () => {
            // Given a conduit and its link()ed child
            const c = new Conduit, f = c.link(), e = new Error;
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
