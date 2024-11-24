import { log, see, describe, expect, it, useRoot, useClock, clock, msg } from "./dev_deps.ts";
import {
    runRules, value, cached, rule, peek, WriteConflict, Signal, Writable, SignalImpl, ConfigurableImpl, action
} from "../src/signals.ts";
import { isObserved, recalcWhen } from "../src/sinks.ts";
import { must, DisposeFn, RecalcSource, mockSource, lazy, each, sleep, root, getJob } from "../src/mod.ts";
import { current } from "../src/ambient.ts";
import { nullCtx } from "../src/internals.ts";
import { defaultQ, demandChanges, unchangedIf } from "../src/cells.ts";

function updateDemand() { demandChanges.flush(); }

// Verify a signal of a given value returns the right things from its methods
function verifySignal<T>(f: (v: T) => Signal<T>, v: T) {
    const s = f(v);
    expect(s()).to.equal(v, "signal() should return its value");
    expect(s.value     ).to.equal(v, "signal.value should return its value");
    expect(s.peek()    ).to.equal(v, "signal.peek() should return its value");
    expect(s.toJSON()  ).to.equal(v, "signal.toJSON() should return its value");
    expect(s.valueOf() ).to.equal(v, "signal.valueOf() should return its value");
    expect(s.toString()).to.equal(`${v}`, "signal.toString() should return its value as a string");
}

function verifyMulti(f: <T>(v: T) => Signal<T>) {
    [1, 2.0, "3", {four: "5"}, function six() {}, true, false, []].forEach(verifySignal.bind(null, f));
}

describe("Signal Constructors/Interfaces", () => {
    useRoot();
    describe("value()", () => {
        useClock();
        it("implements the Signal interface", () => { verifyMulti(value); });
        it("is a Writable instance", () => {
            expect(value(27)).to.be.instanceOf(ConfigurableImpl);
        })
        it("can be set()", () => {
            const val = value();
            verifyMulti(v => { val.set(v); return val as Signal<typeof v>; })
        });
        it("can have its .value set", () => {
            const val = value();
            verifyMulti(v => { val.value = v; return val as Signal<typeof v>; })
        });
        function aValueDependedOnByARule<T>(val: T) {
            const v = value(val);
            rule(() => { log(v()); });
            runRules(); see(`${val}`);
            return v;
        }
        it("ignores set() of the same value", () => {
            // Given a value that's depended on by a rule
            const v = aValueDependedOnByARule(42);
            // When the value is set to the same value
            v.set(42);
            // Then the rule should not run a second time
            runRules(); see();
        });
        it("ignores .value set to the same value", () => {
            // Given a value that's depended on by a rule
            const v = aValueDependedOnByARule(42);
            // When the value is set to the same value
            v.value = 42;
            // Then the rule should not run a second time
            runRules(); see();
        });
        it(".readonly() returns a readonly signal", () => {
            // Given a value() and its .readonly() signal
            const val = value(), s = val.asReadonly();
            // When the value is changed, it should be reflected in the signal
            verifyMulti(v => { val.value = v; return s as Signal<typeof v>; });
            // And the signal should not have a .set() method
            expect((s as Writable<unknown>)["set"]).to.be.undefined;
        });
        it(".withSet() returns a signal with a .set()", () => {
            // Given a value() and its .withSet() signal
            const val = value(), s = val.withSet(log);
            // When the value is changed, it should be reflected in the signal
            verifyMulti(v => { val.value = v; return s as Signal<typeof v>; });
            // And the signal should have a set method that is the given function
            expect(s.set).to.equal(log);
            // And setting the signal's value should call the set method
            s.value = 9999;
            see("9999");
        });
        it("can be subscribed as a source", () => {
            // Given a value and a job that iterates over it with pauses
            const v = value(42), j = root.start(function *(){
                for(const {item, next} of yield *each(v)) {
                    log(item); yield *sleep(10); yield next;
                }
            });
            // When the job starts, it should output the initial value
            clock.tick(0); see("42");
            // And it should reflect changes in the value over time
            v.set(99); clock.tick(10); see("99");
            v.set(27); clock.tick(10); see("27");
            // But changes made while paused are overlooked
            v.set(54); clock.tick(5); see();
            v.set(22); clock.tick(5); see("22");
            v.set(33); clock.tick(5); see();
            // And if the value changes back to the previously-seen value
            // Then there's no new output when iteration resumes
            v.set(22); clock.tick(5); see();
            j.end();
        });
        it("as a source, runs sinks in the null context", () => {
            // Given a value subscribed to as a stream
            const v = value(42);
            const c = root.connect(v, () => { log(current === nullCtx) });
            // When rules run
            runRules();
            // Then the subscriber should be run in the null context
            see("true"); c.end();
        });
        it("doesn't resume until() inside a rule", () => {
            // Given a falsy value
            const v = value(false);
            // When it's waited for via until and then goes truthy
            for(const cb of v["uneventful.until"]()) {
                cb(() => { log(!!current.cell); });
            }
            v.set(true); runRules(); see();
            // Then the resolve should occur asynchronously without being in a rule
            clock.tick(0); see("false");
        });
    });
    describe(".setf()", () => {
        it("triggers recalculation, but detects changes", () => {
            // Given a value observed by a rule
            const v = value(42);
            const r = rule(() => { log(`v: ${v()}`); });
            runRules(); see("v: 42");
            expect(defaultQ.isEmpty()).to.be.true;
            // When it's setf() to a function returning the same value
            v.setf(() => { log("calc"); return 42; });
            // Then the rule should be queued
            expect(defaultQ.isEmpty()).to.be.false; see();
            // And when rules are run, the function should be called
            // but the rule should be skipped:
            runRules(); see("calc");
            // And changing the function to return a different value
            // should run the rule
            v.setf(() => 23); runRules(); see("v: 23");
            // But setting the value to the same value should not
            v.set(23); runRules(); see();
            r();
        });
        it("has its dependencies cleared post-set()", () => {
            // Given a value observed by a rule
            const v = value(42);
            const r = rule(() => { log(`v: ${v()}`); });
            runRules(); see("v: 42");
            // When setf to a function depending on a second value
            const v2 = value(20);
            v.setf(() => { log("recalc"); return v2()*2; });
            runRules(); see("recalc", "v: 40");
            // And the second value changes
            v2.set(21);
            // Then the function should rerun and trigger the rule
            runRules(); see("recalc", "v: 42");
            // But once the first value is set() to a constant again
            v.set(99); runRules(); see("v: 99");
            // Then changing the second value should not schedule anything
            // (because the dependency should no longer exist)
            v2.set(67); expect(defaultQ.isEmpty()).to.be.true;
            r();
        });
        it("has its errors cleared by set() or setf()", () => {
            // Given a value set to an error-throwing function
            const v = value<any>(42).setf(() => { throw "boom!"});
            expect(v).to.throw("boom!");
            expect(v).to.throw("boom!");
            // When set() to  value, Then the error should be gone
            v.set(51); expect(v()).to.equal(51);
            // And if set to an error function
            v.setf(() => { throw "bang"; });
            expect(v).to.throw("bang");
            // And then to the same value as the error
            v.set("bang");
            // Then it should no longer be an error
            expect(v()).to.equal("bang");
            // Until set to a throw again
            v.setf(() => { throw "bang"; });
            expect(v).to.throw("bang");
            // And when replaced by a value-returning funciton
            v.setf(() => 99);
            // Then afterward it should return values again
            expect(v()).to.equal(99);
        });
    });
    describe("cached()", () => {
        useClock();
        it("implements the Signal interface", () => { verifyMulti((v) => cached(() => v)); });
        it("is a Signal instance", () => {
            expect(cached(() => 27)).to.be.instanceOf(SignalImpl);
        })
        it("is idempotent", () => {
            // Given an existing cached() signal
            const c1 = cached(() => 19);
            // When cached() is called on it
            const c2 = cached(c1);
            // Then it should return the same signal
            expect(c2).to.equal(c1);
        });
        it(".readonly() is idempotent", () => {
            // Given a cached() signal
            const c1 = cached(() => 53);
            // When you call .readonly() Then it should return itself
            expect(c1.asReadonly()).to.equal(c1);
        });
        it(".withSet() returns a signal with a .set()", () => {
            // Given a cached() and its .withSet() signal
            const val = value(), c = cached(() => val()), s = c.withSet(log);
            // When the cached changes, it should be reflected in the signal
            verifyMulti(v => { val.value = v; return s as Signal<typeof v>; });
            // And the signal should have a set method that is the given function
            expect(s.set).to.equal(log);
            // And setting the signal's value should call the set method
            s.value = 9999;
            see("9999");
        });
        it("can be subscribed as a source", () => {
            // Given a cached based on a value, and a job that iterates it with pauses
            const v = value(42), s = cached(() => v()*2), j = root.start(function *(){
                for(const {item, next} of yield *each(s)) {
                    log(item); yield *sleep(10); yield next;
                }
            });
            // When the job starts, it should output the initial value
            clock.tick(0); see("84");
            // And it should reflect changes in the value over time
            v.set(99); clock.tick(10); see("198");
            v.set(27); clock.tick(10); see("54");
            // But changes made while paused are overlooked
            v.set(54); clock.tick(5); see();
            v.set(22); clock.tick(5); see("44");
            v.set(33); clock.tick(5); see();
            // And if the value changes back to the previously-seen value
            // Then there's no new output when iteration resumes
            v.set(22); clock.tick(5); see();
            j.end();
        });
        it("as a source, runs sinks in the null context", () => {
            // Given a value subscribed to as a stream
            const v = value(42), s = cached(() => v()*2);
            const c = root.connect(s, () => { log(current === nullCtx) });
            // When rules run
            runRules();
            // Then the subscriber should be run in the null context
            see("true"); c.end();
        });
        describe("Job support", () => {
            it("works like an on-demand rule", () => {
                // Given a cached that does job functions
                const c = cached(() => { log("do"); must(msg("undo")); });
                // When called without subscription
                // Then the job should run and immediately restart
                c(); see("do", "undo");
                // But when subscribed, and the demand is updated
                const r1 = rule(() => void c()); runRules(); updateDemand();
                // Then it should be queued for re-run, but not restart
                see(); runRules(); see("do");
                // And when unsubscribed (w/demand update)
                r1(); updateDemand();
                // It should restart
                see("undo");
                // And when re-subscribed again (w/demand update)
                const r2 = rule(() => void c()); runRules(); updateDemand();
                // Then a recalc should be queued again
                see(); runRules(); see("do");
                r2(); updateDemand(); see("undo");
            });
            it("doesn't roll back during temporary demand dips", () => {
                // Given an observed cached that does job functions
                const c = cached(() => { log("do"); must(msg("undo")); });
                const r1 = rule(() => void c()); runRules(); see("do");
                updateDemand(); runRules(); see();
                // When it's unsubscribed
                r1();  // unsubscribe
                // Then the rollback is queued
                expect(demandChanges.isEmpty()).to.be.false;
                // But if a new subscribe is done before demand update occurs
                const r2 = rule(() => void c()); runRules();
                // Then the rollback is unqueued
                expect(demandChanges.isEmpty()).to.be.true;
                // And doesn't happen (even if demand updates are run)
                updateDemand(); see()
                // Until all subscriptions are ended
                r2(); updateDemand(); see("undo");
            });
            it("rolls back on error", () => {
                // Given a job-using signal that throws
                const c = cached(() => {
                    must(msg("rollback"));
                    throw "boom!"
                });
                // And a rule that catches the error
                const r = rule(() => { try { c(); } catch(e) { log("caught"); } });
                // When run
                runRules();
                // Then the job should be rolled back with the error
                see("rollback", "caught");
                r();
            });
        });
    });
    describe("cached(stream, initVal)", () => {
        it("Follows source when observed, initVal otherwise", () => {
            // Given a mock source lazily wrapped in a cached()
            const e = mockSource<string>();
            const s = lazy(() => {
                log("subscribe"); must(()=>log("unsubscribe")); return e.source;
            });
            const c = cached(s, "unobserved");
            // When the signal is created, it should equal the initial value
            expect(c()).to.equal("unobserved");
            // And emitting values should have no effect on it, nor produce output
            e("testing"); see(); expect(c()).to.equal("unobserved");
            // But after the signal is observed by a rule
            const r = rule(() => log(c())); runRules(); see("unobserved");
            // The source should be susbcribed asynchronously
            updateDemand(); see("subscribe");
            // And emitting values should update the signal and fire the rule
            e("test 1"); runRules(); see("test 1"); expect(c()).to.equal("test 1");
            e("test 2"); runRules(); see("test 2"); expect(c()).to.equal("test 2");
            // But duplicate values should not fire the rule
            e("test 2"); runRules(); see(); expect(c()).to.equal("test 2");
            // And after the rule is disposed of, the source should unsubscribe
            r(); updateDemand(); see("unsubscribe");
            // And the value should revert to the initial value
            expect(c()).to.equal("unobserved");
        });
        it("Resets to default when stream ends", () => {
            // Given a mock source wrapped in a cached() and subscribed
            const e = mockSource<string>();
            const s = lazy(() => {
                log("subscribe"); must(()=>log("unsubscribe")); return e.source;
            });
            const c = cached(s, "unobserved");
            const r = rule(() => log(c())); runRules();
            see("unobserved"); updateDemand(); see("subscribe");
            e("42"); runRules(); see("42")
            // When the source ends and rules run
            e.end(); see("unsubscribe"); runRules();
            // Then its value should revert to the default
            see("unobserved");
            r();
        });
        it("Remains subscribed when unobserved if resubscribed in same tick", () => {
            // Given a mock source wrapped in a cached() and subscribed
            const e = mockSource<string>();
            const s = lazy(() => {
                log("subscribe"); must(()=>log("unsubscribe")); return e.source;
            });
            const c = cached(s, "unobserved");
            const r = rule(() => log(c())); runRules();
            see("unobserved"); updateDemand(); see("subscribe");
            e("42"); runRules(); see("42")
            // When the rule is ended and a new one created and run
            r(); const r2 = rule(() => log(c())); runRules();
            // It should see the last value emitted
            see("42");
            // And any future values
            e("99"); runRules(); see("99")
            // And not unsubscribe until after the second rule ends
            r2(); updateDemand(); see("unsubscribe");
            // At which point the cached should revert to the default value
            expect(c()).to.equal("unobserved");
        });
        it("Becomes an error if the source throws (and resets on unsub)", () => {
            // Given a mock source wrapped in a cached() and subscribed
            const e = mockSource<string>();
            const s = lazy(() => {
                log("subscribe"); must(()=>log("unsubscribe")); return e.source;
            });
            const c = cached(s, "unobserved");
            const r = rule(() => log(c())); runRules();
            see("unobserved"); updateDemand(); see("subscribe");
            e("42"); runRules(); see("42")
            // When the source throws and rules run
            e.throw("boom!"); see("unsubscribe");
            // Then its value should become an error
            expect(runRules).to.throw("boom!");
            // And once there are no more observers
            r(); updateDemand();
            // Then it should revert to the default again.
            expect(c()).to.equal("unobserved");
        });
    });
});

describe("Dependency tracking", () => {
    useRoot();
    describe("unchangedIf()", () => {
        it("errors outside a reactive expression", () => {
            expect(() => unchangedIf(42)).to.throw("unchangedIf() must be called from a reactive expression")
        });
        it("returns the old value if it's the same", () => {
            // Given a cached that computes an equivalent value w/unchangedIf on each call
            const v = value(0); const c = cached(() => { v(); log("calc"); return unchangedIf([1,2,3]); });
            // When it's called more than once
            v.set(1); const v1 = c(); see("calc");
            v.set(2); const v2 = c(); see("calc");
            v.set(3); const v3 = c(); see("calc");
            // Then the same value should be returned each time
            expect(v2).to.equal(v1);
            expect(v3).to.equal(v1);
        });
        it("returns the new value if last value was an error", () => {
            // Given a cached that either throws or computes an equivalent value w/unchangedIf
            const v = value(0);
            const c = cached(() => {
                if (v()<0) throw new Error;
                log("calc"); return unchangedIf([1,2,3]);
            });
            // When its value is saved before and after a throw
            v.set(1); const v1 = c(); see("calc");
            v.set(-1); expect(c).to.throw(); see();
            v.set(1); const v2 = c(); see("calc");
            v.set(-1); expect(c).to.throw(); see();
            // Then the value after the throw should be new
            expect(v2).to.not.equal(v1);
            expect(v2).to.deep.equal(v1);
        });
        it("returns the new value if it's different", () => {
            // Given a cached that computes a varying value w/unchangedIf
            const v = value(0); const c = cached(() => { v(); log("calc"); return unchangedIf([1,2,v()]); });
            // When it's called multiple times
            // Then the values should change
            v.set(1); expect(c()).to.deep.equal([1, 2, 1]); see("calc");
            v.set(2); expect(c()).to.deep.equal([1, 2, 2]); see("calc");
            v.set(3); expect(c()).to.deep.equal([1, 2, 3]); see("calc");
        });
        it("supports custom compare functions", () => {
            // Given a cached that filters a value through a custom comparison
            const eq = value(false), v = value<any>(null);
            function compare(a: any, b: any) {
                log(JSON.stringify(a)); log(JSON.stringify(b)); return eq();
            }
            const c = cached(() => { return unchangedIf(v(), compare); });
            // When the cached is called with different values and comparison results
            // Then the comparison should be called with the previous and new values
            // and the result should only change when the comparison is false
            v.set(null); eq.set(false); expect(c()).to.be.null; see("undefined", "null");
            v.set(42);   eq.set(false); expect(c()).to.eq(42);  see("null", "42");
            v.set(16);   eq.set(true);  expect(c()).to.eq(42);  see("42", "16");
            v.set(16);   eq.set(false); expect(c()).to.eq(16);  see("42", "16");
            v.set(16);   eq.set(true);  expect(c()).to.eq(16);  see("16", "16");
        });
    });
    describe("peek()", () => {
        describe("returns the result of calling the function", () => {
            it("with no arguments", () => {
                // When called with a no argument function
                // Then it should return the result
                expect(peek(() => 42)).to.equal(42);
            });
            it("with arguments", () => {
                // When called with a function and arguments
                // Then it should return the result
                expect(peek((x, y) => ({x, y}), 15, 21)).to.deep.equal({x: 15, y: 21});
            });
            it("without forming a dependency", () => {
                // Given a cached that peeks at a value via peek
                const v = value(42), c = cached(() => peek(v));
                // And has a subscriber (so it will only recompute if a dependency changes)
                rule(() => { c() }); runRules();
                expect(c()).to.equal(42);
                // And a value that has changed after it was peeked
                v.set(43);
                // When the cached is called
                // Then it should still have the old value
                expect(c()).to.equal(42);
            });
            it("without preventing cycle detection on assignment", () => {
                // Given a rule that reads and writes a value with peek
                const v = value(42);
                rule(() => { peek(() => { v.set(v()+1); }); })
                // When the rule is run,
                // Then it should still throw a write conflict
                expect(runRules).to.throw(WriteConflict);
            });
            it("without blocking access to an enclosing rule's job", () => {
                // Given a rule with a peek() block that accesses the current job
                const stop = rule(() => { peek(getJob); })
                // When it's run
                runRules()
                // Then it should not produce an error
                stop()
            });
        })
    });
    describe("action()", () => {
        it("passes arguments+this, returning result", () => {
            // Given an action-wrapped function
            const that = {};
            const t = action(function (this: {}, a: number, b: string) {
                log(this === that);
                log(a);
                log(b);
                log(!!current.cell);
                return 42;
            });
            // When called w/args and a `this`
            const res = cached(() => t.call(that, 99, "foo"))();

            // Then the inner function should be called without tracking,
            // with the given args and `this`
            see("true", "99", "foo", "false");

            // And the wrapped function's return value should be
            // the value from the inner function return
            expect(res).to.equal(42);
        });
        it("works as a decorator", () => {
            // Given an instance of a class w/an @action-decorated method
            // (experimental/legacy mode)
            class X {
                @action
                method(a: number, b: string) {
                    log(this === that);
                    log(a);
                    log(b);
                    log(!!current.cell);
                    return 42;
                }
            }
            const that = new X;
            // When the method is called w/args
            const res = cached(() => that.method(99, "foo"))();

            // Then the method should be called in a new job
            // that's the same as the return value, with the
            // object as its `this`
            see("true", "99", "foo", "false");

            // And the wrapped function's eventual return
            // goes to the enclosing job
            expect(res).to.equal(42);
        });
    });
    describe("isObserved()", () => {
        it("returns undefined outside a signal", () => {
            expect(isObserved()).to.be.undefined;
        });
        it("returns the current observation state inside a signal", () => {
            // Given a cached that returns its observed state
            const c = cached(() => {
                const io = isObserved();
                log(`calculating: ${io}`);
                return io;
            });
            // When called without subscription
            c();
            // Then it should run and return false
            see("calculating: false");
            // But when subscribed, and the demand is updated
            const r1 = rule(() => void c()); runRules(); updateDemand();
            // Then it should be queued for re-run and return true
            see(); runRules(); see("calculating: true");
            // And when unsubscribed (w/demand update)
            r1(); updateDemand();
            // And then re-subscribed (w/demand update)
            const r2 = rule(() => void c()); runRules(); updateDemand();
            // Then a recalc should be queued again
            see(); runRules(); see("calculating: true");
            r2(); updateDemand(); see();
        });
    });
    describe("recalcWhen()", () => {
        useRoot()
        it("subscribes and unsubscribes on demand", () => {
            // Given a rule that depends on a mock source
            let changed: () => void;
            const src: RecalcSource = (cb) => { changed = cb; log("sub"); must(()=> log("unsub")); }
            const end = rule(() => { recalcWhen(src); log("ping"); });
            // When the rule is run
            see(); runRules();
            // Then the source should be subscribed afterward
            see("ping"); updateDemand(); see("sub");
            runRules(); see();
            // And when the source produces a value
            changed(); see();
            // Then the rule should update
            runRules(); see("ping");
            // And when the rule is ended
            end()
            // Then the source should be unsubscribed afterward
            updateDemand(); see("unsub");
            // And then resubscribed after new rules are added
            const e2 = rule(() => { recalcWhen(src); log("ping"); });
            runRules(); see("ping"); updateDemand(); see("sub");
            changed(); runRules(); see("ping");
            // Without a second subscribe for subsequent rules
            const e3 = rule(() => { recalcWhen(src); log("pong"); });
            runRules(); see("pong");
            // And changes propagate to all rules
            changed(); runRules(); see("pong", "ping");
            // With a final unsubscribe after there are no longer any observing rules
            e2(); see();
            e3(); updateDemand(); see("unsub");
        });
        it("supports key+factory for creating sources on the fly", () => {
            // Given rules keyed to different sources
            type o = {n: number, cb?: DisposeFn};
            const factory = (key: o): RecalcSource => (cb) => {
                key.cb = cb; log(`sub ${key.n}`); must(()=> log(`unsub ${key.n}`));
            }
            const o1: o = {n:1}, o2: o = {n:2};
            const r1 = rule(() => { recalcWhen(o1, factory); log("ping 1"); });
            const r2 = rule(() => { recalcWhen(o2, factory); log("ping 2"); });
            // When they are run
            see(); runRules();
            // Then the sources should each be subscribed afterward
            see("ping 1", "ping 2"); updateDemand(); see("sub 1", "sub 2");
            // And when they are updated, the rules should recalc
            o1.cb(); runRules(); see("ping 1");
            o2.cb(); runRules(); see("ping 2");
            // And when ended, they should unsubscribe afterward
            r2(); updateDemand(); see("unsub 2");
            r1(); updateDemand(); see("unsub 1");
        });
        it("throws and kills its job on setup error", () => {
            // Given a source that throws and a rule that references it
            const src: RecalcSource = () => { log("sub"); must(()=> log("unsub")); throw "boom"; }
            const end = rule(() => { recalcWhen(src); log("ping"); });
            // When the rule is run
            runRules(); see("ping");
            // Then the error should throw asynchronously to detached
            // and the subscription should be rolled back
            updateDemand(); see("sub", "unsub", "Uncaught: boom");
            runRules(); see();
            end(); see();
        });
    });
});

describe("Signal invariants", () => {
    useRoot();

    it("Updates are immediate outside of rules", () => {
        // Given a value
        const v = value(42); // Given a value
        // And a cached() of that value
        const c1 = cached(() => v() * 2); // And a cached() of that value
        // And a cached() depending on that cached()
        const c2 = cached(() => c1() * 2);
        // When the value is set outside a rule
        v.set(43);
        // Then all the values should be visibly changed
        expect(v()).to.equal(43);
        expect(c1()).to.equal(86);
        expect(c2()).to.equal(172);
    });

    it("Inter-rule updates appear immediate while rules are executing", () => {
        // Given a value
        const v = value(42);
        // And a cached() of that value
        const c1 = cached(() => v() * 2);
        // And a cached() depending on that cached()
        const c2 = cached(() => c1() * 2);
        // When the value is set inside a rule
        const v2 = value(43);
        rule(() => { v.set(v2()); });
        rule(() => { log(`${v()}, ${c1()}, ${c2()}`); });
        // Then other rules should see only the modified values
        runRules();
        see("43, 86, 172");
        // Even if repeated
        v2.set(44);
        runRules();
        see("44, 88, 176");
    });

    describe("Updates run only when needed (once per batch max)", () => {});
    describe("Rules are asynchronous", () => {});
    describe("Cycles result in errors", () => {});
});