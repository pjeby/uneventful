import { log, see, describe, expect, it, useRoot, spy, msg } from "./dev_deps.ts";
import { runRules, value, cached, rule, CircularDependency, WriteConflict } from "../src/signals.ts";
import { defer } from "../src/defer.ts";
import { Cell, defaultQ, demandChanges, ruleQueue, unchangedIf } from "../src/cells.ts";
import { IsStream, must } from "../mod.ts";

describe("Demand management", () => {
    describe("Subscriber changes", () => {
        it("shouldn't trigger updates if cell has a queue", () => {
            // Given a monitored cell with a queue
            const c = Cell.mkStream(() => IsStream);
            c.setQ(defaultQ); demandChanges.flush();
            // When the cell is subscribed
            const r = rule.root(() => c.getValue()); runRules();
            // Then an update should not be queued
            expect(demandChanges.has(c)).to.be.false;
            // And when it is unsubscribed
            r(); runRules();
            // Then an update should still not be queued
            expect(demandChanges.has(c)).to.be.false;
        });
        it("doesn't double-recalc an observed cell", () => {
            // Given a cached that does job functions,
            const c = Cell.mkCached(() => { log("do"); must(msg("undo")); });
            // That is both stateful
            c.getValue(); see("do", "undo");  // it's stateful now
            expect(demandChanges.isEmpty()).to.be.true;
            // And observed (and queued for demand update)
            c.setQ(defaultQ);
            expect(demandChanges.isEmpty()).to.be.false;
            // When it's recalculated before the demand queue flushes
            c.shouldWrite(true); c.getValue(); see("do");
            // Then it should be removed from the queue
            expect(demandChanges.isEmpty()).to.be.true;
            // And not scheduled for recalc when the queue flushes
            demandChanges.flush(); runRules(); see();
        });
    });
    describe("Queue changes", () => {
        it("should trigger demand updates", () => {
            // Given a monitored cell that's not subscribed
            const c = Cell.mkStream(() => IsStream);
            expect(demandChanges.isEmpty()).to.be.true;
            // When it's given a queue
            c.setQ(defaultQ);
            // Then it should be scheduled for a demand update
            expect(demandChanges.isEmpty()).to.be.false;
            demandChanges.flush();
            expect(demandChanges.isEmpty()).to.be.true;
            // And when the queue is removed again
            c.setQ(null);
            // Then it should be scheduled again
            expect(demandChanges.isEmpty()).to.be.false;
            demandChanges.flush();
            expect(demandChanges.isEmpty()).to.be.true;
        });
        it("should trigger subscribe and unsubscribe", () => {
            // Given a cell with a source
            const s = Cell.mkValue(42), c = Cell.mkCached(() => s.getValue());
            c.getValue(); expect(c.sources.src).to.equal(s);
            expect(s.subscribers).to.be.undefined;
            // When it's given a queue
            c.setQ(defaultQ);
            // Then it should arrange for its source to subscribe to it
            expect(s.subscribers.tgt).to.equal(c);
            // And when the queue is changed
            c.setQ(ruleQueue(() => {}));
            // Then the subscription state should not change
            expect(s.subscribers.tgt).to.equal(c);
            // Until the queue is removed entirely
            c.setQ(null);
            // And then it should be unsubscribed
            expect(s.subscribers).to.be.undefined;
        });
    });
});

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
        it("that's virtually read before it", () => {
            // Given a multipart condition with short-circuit evaluation
            const v1 = value(42), v2 = value(57), s = value("started");
            const c = cached(() => !!(v1() && v2()));
            rule(() => { if(c()) log(s()); })
            runRules(); see("started");
            // When it has a phantom read on a dependency
            v2.set(99); runRules(); see();
            // Then writing that dependency from a rule should fail
            rule(() => s.set("changed"));
            expect(runRules).to.throw("Value already used");
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
    it("handles conditional indirect resubscribes", () => {
        // Given two rules conditionally subscribed indirectly to the same value
        const condition = value(false), commonVal = value(42);
        const indirect = cached(() => void log(commonVal()));
        rule(() => { if (condition()) commonVal(); });
        rule(() => { if (condition()) indirect()});
        runRules(); see();
        // When the condition is turned on...
        condition.set(true); runRules(); see("42");
        commonVal.set(66); runRules(); see("66");
        commonVal.set(17); runRules(); see("17");
        // off...
        condition.set(false); runRules(); see();
        commonVal.set(42); runRules(); see();
        // and on again
        condition.set(true); runRules(); see("42");
        // Then the indirect calculation should be subscribed again
        commonVal.set(66); runRules(); see("66");
    });
    it("with different-length paths to common element", () => {
        const start = value(22);
        const indirect = cached(() => start() * 1.5);
        const direct = rule(() => log(`${start()}, ${indirect()}`));
        runRules(); see("22, 33");
        start.set(44);
        runRules(); see("44, 66");
        direct();
    });
    it("with changes to short-circuited evaluations", () => {
        // Given a multipart condition with short-circuit evaluation
        const v1 = value(42), v2 = value(57), s = value("started");
        const c = cached(() => !!(v1() && v2()));
        rule(() => { if(c()) log(s()); })
        runRules(); see("started");
        // When its conditions change
        // Then nothing happens unless the truthiness changes
        v2.set(99); runRules(); see();
        // Or a dependency of the action changes (i.e., a write to a
        // short-circuited evaluation should trigger recalculation here)
        s.set("changed"); runRules(); see("changed");
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
    });
    it("passes the state managers' efficiency test (w/custom compare)", () => {
        // adapted from https://habr.com/ru/articles/707600/
        function hard_work<T>(x: T) { return x; }
        let A = value(0); // unique values: 1 2 3 4 ...
        let B = value(0); // toggle values: 1 2 1 2 ...
        const C = cached(()=> { return A() % 2 + B() % 2}) // toggle values
        const D = cached(()=> { return unchangedIf([A() % 2 - B() % 2]) }) // same value: [0]
        const E = cached(()=> { log("E"); return hard_work( C() + A() + D()[0] )}) // unique values
        const F = cached(()=> { log("F"); return hard_work( D()[0] && B() )}) // same value
        const G = cached(()=> { return C() + ( C() || E() % 2 ) + D()[0] + F()}) // toggle values
        rule(()=> { log("H"); hard_work( G() ); }) // toggle values
        rule(()=> { G(); }) // toggle values
        rule(()=> { log("J"); hard_work( F() );} ) // single run
        runRules();
        see("H", "E", "F", "J");
        A.set(1); B.set(1); runRules();
        see("H");
        A.set(2); B.set(2); runRules();
        see("E", "H");
        A.set(3); B.set(1); runRules();
        see("H");
        A.set(4); B.set(2); runRules();
        see("E", "H");
    });
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
        const c: () => any = cached(() => c());
        // When it's called
        // Then it should throw an error
        expect(c).to.throw(CircularDependency);
    });
    it("detects indirect self-reference", () => {
        // Given a cached that calls itself indirectly
        const c1: () => any = cached(() => c2()), c2 = cached(() => c1());
        // When it's called
        // Then it should throw an error
        expect(c1).to.throw(CircularDependency);
    });
    it("doesn't rerun without dependencies", () => {
        // Given a cached() with no dependencies that has run once
        const c = cached(() => { log("run"); return 42; });
        expect(c()).to.equal(42); see("run");
        // When other values change
        const v = value(99); v(); v.set(55);
        // Then the cached() should not rerun
        c(); see();
    });
    it("ignores dependency on a cached with no dependencies", () => {
        // Given a cached with no dependencies and another that reads it
        const c1 = Cell.mkCached(() => {
            log("run 1"); return 42;
        });
        const c2 = Cell.mkCached(() => {
            log("run 2");
            return c1.getValue();
        });
        // When the second is run
        expect(c2.getValue()).to.equal(42);
        // Then it should not have a dependency
        expect(c2.sources).to.be.undefined;
        see("run 2", "run 1");
    });
    it("unsubscribes listeners if it loses its dependencies", () => {
        // Given a signal that can become constant
        let constant = false;
        const v = value(42), s = Cell.mkCached(() => { if (!constant) return v(); else return 42; });
        // And various subscribers
        const c1 = Cell.mkCached(() => s.getValue()), c2 = Cell.mkCached(() => s.getValue());
        const r = rule.root(() => c1.getValue()); c2.setQ(defaultQ);
        runRules();
        expect(s.subscribers).to.not.be.undefined;
        expect(c1.subscribers).to.not.be.undefined;
        expect(c2.sources).to.not.be.undefined;
        // When the signal becomes constant
        constant = true; v.set(43); // change value to trigger recalc, but return value is still 42
        s.getValue(); // recalc and unsubscribe everything
        // Then the subscribers should be removed (recursively where no other deps exist)
        expect(s.subscribers).to.be.undefined;
        expect(c1.subscribers).to.be.undefined;
        expect(c2.sources).to.be.undefined;
        r();
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

describe("rule.factory()", () => {
    it("returns the default factory by default", () => {
        // Given a factory returned by rule.factory(defer)
        const newRule = rule.factory(defer);
        // Then it should be the same as rule
        expect(newRule).to.equal(rule);
    });
    it("is idempotent for a given argument", () => {
        // Given a factory returned by rule.factory(fn)
        const fn = () => {}, s = rule.factory(fn);
        // When rule.factory is called with the same function
        // Then it should return the same RuleFactory
        expect(rule.factory(fn)).to.equal(s);
    });
    describe("returns a RuleFactory that", () => {
        useRoot();
        it("can be used to create rules that run separately", () => {
            // Given a factory based on a spy
            const cb = spy(), newRule = rule.factory(cb);
            // When a rule is created with the factory
            newRule(() => log("run"));
            // Then it should not run during normal runRules()
            runRules(); see();
            // But only when the requested callback is run
            cb.args[0][0](); see("run");
        });
        it("will defer its flush if another factory is flushing", () => {
            // Given a new rule in a custom factory
            const v = value<Function>(), s = rule.factory(v.set);
            s(() => log("inner flush"));
            // Which has therefore scheduled itself
            const flush = v();
            v.set(undefined);  // clear value so we can tell when it's scheduled again
            // and a (main-schedule) rule that flushes it
            rule(() => {
                flush();
                log("outer flush");
            });
            // When the main scheduler is flushed
            runRules();
            // Then the nested flush should not run
            see("outer flush");
            // Until the (now-rescheduled) factory's rules run
            v()();
            see("inner flush");
        });
    });
});
