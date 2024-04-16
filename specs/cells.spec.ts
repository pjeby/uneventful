import { log, see, describe, expect, it, useRoot, spy } from "./dev_deps.ts";
import { runRules, value, cached, rule, CircularDependency, RuleScheduler, WriteConflict } from "../mod.ts";
import { defer } from "../src/defer.ts";

describe("Cycles and Side-Effects", () => {
    useRoot();
    it("cached() can't create side-effects", () => {
        const v = value(99), w = cached(() => v.set(42));
        expect(w).to.throw("Side-effects not allowed")
    });
    describe("rule() can set a value", () => {
        it("before it peek()s it", () => {
            // Given two values
            const v1 = value(42), v2 = value(43);
            // When the first value is set from the second, inside a rule
            // that peeks at the result
            rule(() => { v1.set(v2()); log(v1.peek()); });
            // Then it should run once
            runRules(); see("43");
            // And When it's run a second time,
            ++v2.value;
            // It still works (because there's no dependency and no conflict)
            runRules(); see("44");
        });
    });
    describe("rule() can't set a value", () => {
        it("after it reads it", () => {
            const v = value(99);
            rule(() => { v.set(v()+1); })
            expect(runRules).to.throw(CircularDependency);
        });
        it("after it peek()s it", () => {
            const v = value(99);
            rule(() => { v.set(v.peek()+1); })
            expect(runRules).to.throw(WriteConflict);
        });
        it("before it reads it", () => {
            // Given a value
            const v = value(42);
            // When the value is set inside a rule that reads it afterward
            rule(() => { v.set(43); log(v()); });
            runRules();
            // Then it should run once
            see("43");
            // But When it's run a second time,
            ++v.value;
            // Then it should throw a circular update error
            expect(runRules).to.throw(CircularDependency);
        });
        it("that's indirectly read before it", () => {
            // Given a value and a cached function that depends on it
            const v1 = value(99), c1 = cached(() => v1()*2);
            // And a second value updated by rule from the cached function
            const v2 = value(0);
            rule(() => v2.set(c1()));
            // When another rule tries to write the first value
            rule(() => { v1.set(v2()); });
            // Then it should detect a write conflict
            expect(runRules).to.throw(WriteConflict)
            // And the value should not be changed
            expect(v1()).to.equal(99);
            // But the first rule should have run
            expect(v2()).to.equal(198);
            // And it should still be active
            v1.set(23); runRules(); expect(v2()).to.equal(46);
        });
    });
    // XXX shouldn't sp.run(), job(), cleanup, and many more from inside cached?
    // don't allow create rule() inside cached?
    // prevent self-dependency in cached()
});


describe("Consistent updates", () => {
    useRoot();
    it("with multiple paths to common element", () => {
        // Given a rule with two paths to a common value
        const start = value(22);
        const route1 = cached(() => start() - 1);
        const route2 = cached(() => start() + 1);
        const common = rule(() => log(`${route1()}, ${route2()}`));
        // When rules are run Then the callback should only run once, with consistent data
        runRules(); see("21, 23");
        // And When the common value is changed and rules are run
        start.set(44);
        // Then the callback should again run only once, with consistent data
        runRules(); see("43, 45");
        common();
    })
    it("with different-length paths to common element", () => {
        const start = value(22);
        const indirect = cached(() => start() * 1.5);
        const direct = rule(() => log(`${start()}, ${indirect()}`));
        runRules(); see("22, 33");
        start.set(44);
        runRules(); see("44, 66");
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
        rule(()=> { log("H"); hard_work( G() ); }) // toggle values
        rule(()=> { G(); }) // toggle values
        rule(()=> { log("J"); hard_work( F() );} ) // single run
        runRules();
        see("H", "E", "F", "J");
        A.set(1); B.set(1); runRules();
        see("F", "H");
        A.set(2); B.set(2); runRules();
        see("E", "F", "H");
        A.set(3); B.set(1); runRules();
        see("F", "H");
        A.set(4); B.set(2); runRules();
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

describe("rule()", () => {
    useRoot();
    it("should call the function on tick", () => {
        rule(() => log("called"));
        runRules();
        see("called");
    });
    it("should call it again if a value changes (if subscribed and ticked)", () => {
        const v = value(42);
        const d = rule(() => log(v()));
        runRules();
        see("42");
        v.set(99);
        see();
        runRules();
        see("99");
        d();  // dispose
        v.set(17);
        runRules();
        see(); // no further output
    });
    it("should dynamically update subscriptions", () => {
        const v = value(42), w = value(16);
        rule(() => log(v() && w()));
        runRules();
        see("16");
        w.set(23); runRules();
        see("23");
        v.set(0); runRules();
        see("0");
        w.set(66); runRules();
        see();
        v.set(1); runRules();
        see("66");
    });
});

describe("RuleScheduler.for()", () => {
    it("returns the default scheduler by default", () => {
        // Given a scheduler returned by RuleScheduler.for(defer)
        const s = RuleScheduler.for(defer);
        // Then it should be the same as RuleScheduler.for()
        expect(s).to.equal(RuleScheduler.for());
        // And its .flush should be the same as runRules
        expect(s.flush).to.equal(runRules);
    });
    it("is idempotent for a given argument", () => {
        // Given a scheduler returned by RuleScheduler.for(fn)
        const fn = () => {}, s = RuleScheduler.for(fn);
        // When RuleScheduler.for is called with the same function
        // Then it should return the same RuleScheduler
        expect(RuleScheduler.for(fn)).to.equal(s);
    });
    describe("returns a RuleScheduler that", () => {
        useRoot();
        it("can be used to create rules that run separately", () => {
            // Given a scheduler based on a spy
            const cb = spy(), s = RuleScheduler.for(cb);
            // When a rule is added to the scheduler
            s.rule(() => log("run"));
            // Then it should not run during normal runRules()
            runRules(); see();
            // But only when the requested callback is run
            cb.args[0][0](); see("run");
        });
    });
});

describe("RuleScheduler", () => {
    useRoot();
    it("will defer its flush if another scheduler is flushing", () => {
        // Given a populated custom scheduler
        const v = value<Function>(), s = RuleScheduler.for(v.set);
        s.rule(() => log("inner flush"));
        // Which has therefore scheduled itself
        const flush = v();
        v.set(undefined);  // clear value so we can tell when it's scheduled again
        // and a (main-schedule) rule that flushes it
        rule(() => {
            flush();
            log("outer flush");
        });
        // When the main schedule is flushed
        runRules();
        // Then the nested flush should not run
        see("outer flush");
        // Until the (now-rescheduled) custom scheduler runs
        v()();
        see("inner flush");
    });
});
