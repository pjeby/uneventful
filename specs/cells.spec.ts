import { log, see, describe, expect, it, useRoot, spy } from "./dev_deps.ts";
import { runEffects, value, cached, effect } from "../mod.ts";
import { Cell, CircularDependency, EffectScheduler, WriteConflict } from "../src/cells.ts";
import { defer } from "../src/defer.ts";

describe("Cycles and Side-Effects", () => {
    useRoot();
    it("cached() can't create side-effects", () => {
        const v = value(99), w = cached(() => v.set(42));
        expect(w).to.throw("Side-effects not allowed")
    });
    describe("effect() can set a value", () => {
        it("before it peek()s it", () => {
            // Given two values
            const v1 = value(42), v2 = value(43);
            // When the first value is set from the second, inside an effect
            // that peeks at the result
            effect(() => { v1.set(v2()); log(v1.peek()); });
            // Then it should run once
            runEffects(); see("43");
            // And When it's run a second time,
            ++v2.value;
            // It still works (because there's no dependency and no conflict)
            runEffects(); see("44");
        });
    });
    describe("effect() can't set a value", () => {
        it("after it reads it", () => {
            const v = value(99);
            effect(() => { v.set(v()+1); })
            expect(runEffects).to.throw(CircularDependency);
        });
        it("after it peek()s it", () => {
            const v = value(99);
            effect(() => { v.set(v.peek()+1); })
            expect(runEffects).to.throw(WriteConflict);
        });
        it("before it reads it", () => {
            // Given a value
            const v = value(42);
            // When the value is set inside an effect that reads it afterward
            effect(() => { v.set(43); log(v()); });
            runEffects();
            // Then it should run once
            see("43");
            // But When it's run a second time,
            ++v.value;
            // Then it should throw a circular update error
            expect(runEffects).to.throw(CircularDependency);
        });
        it("that's indirectly read before it", () => {
            // Given a value and a cached function that depends on it
            const v1 = value(99), c1 = cached(() => v1()*2);
            // And a second value updated by effect from the cached function
            const v2 = value(0);
            effect(() => v2.set(c1()));
            // When another effect tries to write the first value
            effect(() => { v1.set(v2()); });
            // Then it should detect a write conflict
            expect(runEffects).to.throw(WriteConflict)
            // And the value should not be changed
            expect(v1()).to.equal(99);
            // But the first effect should have run
            expect(v2()).to.equal(198);
            // And it should still be active
            v1.set(23); runEffects(); expect(v2()).to.equal(46);
        });
    });
    // XXX shouldn't sp.run(), job(), cleanup, and many more from inside cached?
    // don't allow create effect() inside cached?
    // prevent self-dependency in cached()
});


describe("Consistent updates", () => {
    useRoot();
    it("with multiple paths to common element", () => {
        // Given an effect with two paths to a common value
        const start = value(22);
        const route1 = cached(() => start() - 1);
        const route2 = cached(() => start() + 1);
        const common = effect(() => log(`${route1()}, ${route2()}`));
        // When effects are run Then the callback should only run once, with consistent data
        runEffects(); see("21, 23");
        // And When the common value is changed and effects are run
        start.set(44);
        // Then the callback should again run only once, with consistent data
        runEffects(); see("43, 45");
        common();
    })
    it("with different-length paths to common element", () => {
        const start = value(22);
        const indirect = cached(() => start() * 1.5);
        const direct = effect(() => log(`${start()}, ${indirect()}`));
        runEffects(); see("22, 33");
        start.set(44);
        runEffects(); see("44, 66");
        direct();
    });
    it("passes the state managers' efficiency test", () => {
        // adapted from https://habr.com/ru/articles/707600/
        function hard_work<T>(x: T) { return x; }
        let A = value(0); // unique values: 1 2 3 4 ...
        let B = value(0); // toggle values: 1 2 1 2 ...
        const C = cached(()=> { return A() % 2 + B() % 2}) // toggle values
        const D = cached(()=> { return [A() % 2 - B() % 2] }) // same value: [0]
        const E = cached(()=> { log("E"); return hard_work( C() + A() + D()[0] )}) // unique values
        const F = cached(()=> { log("F"); return hard_work( D()[0] && B() )}) // same value
        const G = cached(()=> { return C() + ( C() || E() % 2 ) + D()[0] + F()}) // toggle values
        effect(()=> { log("H"); hard_work( G() ); }) // toggle values
        effect(()=> { G(); }) // toggle values
        effect(()=> { log("J"); hard_work( F() );} ) // single run
        runEffects();
        see("H", "E", "F", "J");
        A.set(1); B.set(1); runEffects();
        see("F", "H");
        A.set(2); B.set(2); runEffects();
        see("E", "F", "H");
        A.set(3); B.set(1); runEffects();
        see("F", "H");
        A.set(4); B.set(2); runEffects();
        see("E", "F", "H");
    })
});

describe("cached()", () => {
    it("caches error instances", () => {
        // Given a cached that throws an error
        const c = cached(() => { throw new Error; });
        // When called more than once
        function getError() { try { c(); } catch (e) { return e; } }
        const e1 = getError();
        const e2 = getError();
        // It should return the exact same instance
        expect(e1).to.be.instanceOf(Error);
        expect(e2).to.be.instanceOf(Error);
        expect(e1).to.equal(e2);
    });
    it("can recover after an error", () => {
        // Given a cached that throws an error based on a flag
        const flag = value(true);
        const c = cached(() => { if (flag()) throw new Error; });
        // When called with the true value
        function getError() { try { c(); } catch (e) { return e; } }
        const e1 = getError();
        // Then it should get an error
        expect(e1).to.be.instanceOf(Error);
        // But when the flag is false
        flag.set(false);
        // Then it should return a value
        expect(c()).to.be.undefined;
    });
    it("detects direct self-reference", () => {
        // Given a cached that calls itself
        const c = cached(() => c());
        // When it's called
        // Then it should throw an error
        expect(c).to.throw(CircularDependency);
    });
    it("detects indirect self-reference", () => {
        // Given a cached that calls itself indirectly
        const c1 = cached(() => c2()), c2 = cached(() => c1());
        // When it's called
        // Then it should throw an error
        expect(c1).to.throw(CircularDependency);
    });
});

describe("effect()", () => {
    useRoot();
    it("should call the function on tick", () => {
        effect(() => log("called"));
        runEffects();
        see("called");
    });
    it("should call it again if a value changes (if subscribed and ticked)", () => {
        const v = value(42);
        const d = effect(() => log(v()));
        runEffects();
        see("42");
        v.set(99);
        see();
        runEffects();
        see("99");
        d();  // dispose
        v.set(17);
        runEffects();
        see(); // no further output
    });
    it("should dynamically update subscriptions", () => {
        const v = value(42), w = value(16);
        effect(() => log(v() && w()));
        runEffects();
        see("16");
        w.set(23); runEffects();
        see("23");
        v.set(0); runEffects();
        see("0");
        w.set(66); runEffects();
        see();
        v.set(1); runEffects();
        see("66");
    });
});

describe("EffectScheduler.for()", () => {
    it("returns the default scheduler by default", () => {
        // Given a scheduler returned by EffectScheduler.for(defer)
        const s = EffectScheduler.for(defer);
        // Then it should be the same as EffectScheduler.for()
        expect(s).to.equal(EffectScheduler.for());
        // And its .flush should be the same as runEffects
        expect(s.flush).to.equal(runEffects);
    });
    it("is idempotent for a given argument", () => {
        // Given a scheduler returned by EffectScheduler.for(fn)
        const fn = () => {}, s = EffectScheduler.for(fn);
        // When EffectScheduler.for is called with the same function
        // Then it should return the same EffectScheduler
        expect(EffectScheduler.for(fn)).to.equal(s);
    });
    describe("returns an EffectScheduler that", () => {
        useRoot();
        it("calls the function on transition from empty", () => {
            // Given a scheduler based on a spy
            const cb = spy(), s = EffectScheduler.for(cb);
            // When a cell is added to the scheduler
            s.add(new Cell);
            // Then the spy should be called with a function
            expect(cb).to.have.been.calledOnce;
            // And if another cell is added
            s.add(new Cell);
            // Then the spy should not have been called again
            expect(cb).to.have.been.calledOnce;
            // But if the scheduler is flushed by calling the callback it gave
            cb.args[0][0]();
            // The scheduler should be empty
            expect(s.isEmpty()).to.be.true;
            // And adding a cell again should schedule it again
            s.add(new Cell);
            expect(cb).to.have.been.calledTwice;
        });
        it("can be used to create effects that run separately", () => {
            // Given a scheduler based on a spy
            const cb = spy(), s = EffectScheduler.for(cb);
            // When an effect is added to the scheduler
            s.effect(() => log("run"));
            // Then it should not run during normal runEffects()
            runEffects(); see();
            // But only when the requested callback is run
            cb.args[0][0](); see("run");
        });
    });
});

describe("EffectScheduler", () => {
    useRoot();
    it("won't flush() while already flushing", () => {
        // Given a scheduler and an effect that calls flush()
        const v = value<Function>(), s = EffectScheduler.for(v.set);
        s.effect(() => {
            s.flush();
            log(s.isEmpty());
            log("done");
        });
        // When the scheduler is flushed
        s.flush();
        // Then the nested flush should not empty the scheduler
        see("false", "done");
    });
    it("will defer its flush if another scheduler is flushing", () => {
        // Given a populated scheduler
        const v = value<Function>(), s = EffectScheduler.for(v.set);
        s.effect(() => log("inner flush"));
        // Which has therefore scheduled itself
        const flush = v();
        v.set(undefined);  // clear value so we can tell when it's scheduled again
        // and a (main-schedule) effect that flushes it
        effect(() => {
            flush();
            log(s.isEmpty());
            log("outer flush");
        });
        // When the main schedule is flushed
        runEffects();
        // Then the nested flush should not run
        see("false", "outer flush");
        // Until the rescheduled scheduler runs
        v()();
        see("inner flush");
    });
    it("will reschedule itself if flush aborts and effects are still pending", () => {
        // Given a scheduler with two effects (the first of which throws an error)
        const v = value<Function>(), s = EffectScheduler.for(v.set);
        s.effect(() => {throw new Error});
        s.effect(() => log("run"));
        // Which has therefore scheduled itself
        const scheduledFlush = v(); v.set(undefined);
        // When the scheduler is flushed and the error thrown
        expect(scheduledFlush).to.throw(Error);
        // Then the scheduler should have scheduled itself to run again
        expect(v()).to.be.a("function");
    });
    it("won't reschedule itself if already flushing", () => {
        // Given a scheduler with an effect that removes itself and adds another
        const v = value<Function>();
        const s = EffectScheduler.for(f => { v.set(f); log("scheduled"); });
        const c = new Cell; c.catchUp = () => {
            s.delete(c); s.add(new Cell);
        }
        s.add(c);
        see("scheduled");
        // When the scheduler is flushed on schedule
        const scheduledFlush = v(); v.set(undefined);
        scheduledFlush();
        // Then it should not schedule itself again
        see();
        expect(v()).to.be.undefined;
    });
    it("won't reschedule itself if it hasn't been called back", () => {
        // Given a scheduler with an item
        const s = EffectScheduler.for(() => log("scheduled"));
        const c = new Cell;
        s.add(c);
        see("scheduled");
        // When the item is removed and then added again
        s.delete(c); s.add(c);
        // Then the scheduler should not have rescheduled
        see();
    });
});