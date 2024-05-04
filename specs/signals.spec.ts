import { log, see, describe, expect, it, useRoot, useClock, clock } from "./dev_deps.ts";
import {
    runRules, value, cached, rule, noDeps, WriteConflict, Signal, Writable, must, recalcWhen,
    DisposeFn, RecalcSource, mockSource, lazy, detached, each, sleep
} from "../mod.ts";

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
    useClock();
    describe("value()", () => {
        it("implements the Signal interface", () => { verifyMulti(value); });
        it("is a Writable instance", () => {
            expect(value(27)).to.be.instanceOf(Writable);
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
            const val = value(), s = val.readonly();
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
            const v = value(42), j = detached.start(function *(){
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
    });
    describe("cached()", () => {
        it("implements the Signal interface", () => { verifyMulti((v) => cached(() => v)); });
        it("is a Signal instance", () => {
            expect(cached(() => 27)).to.be.instanceOf(Signal);
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
            expect(c1.readonly()).to.equal(c1);
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
            const v = value(42), s = cached(() => v()*2), j = detached.start(function *(){
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
            // But once the signal is observed by a rule
            const r = rule(() => log(c())); runRules();
            // The source should be susbcribed
            see("subscribe", "unobserved");
            // And emitting values should update the signal and fire the rule
            e("test 1"); runRules(); see("test 1"); expect(c()).to.equal("test 1");
            e("test 2"); runRules(); see("test 2"); expect(c()).to.equal("test 2");
            // But duplicate values should not fire the rule
            e("test 2"); runRules(); see(); expect(c()).to.equal("test 2");
            // And if the rule is disposed of, the source should unsubscribe
            r(); see("unsubscribe");
            // And the value should revert to the initial value
            expect(c()).to.equal("unobserved");
        });
    });
});

describe("Dependency tracking", () => {
    useRoot();
    describe("noDeps()", () => {
        describe("returns the result of calling the function", () => {
            it("with no arguments", () => {
                // When called with a no argument function
                // Then it should return the result
                expect(noDeps(() => 42)).to.equal(42);
            });
            it("with arguments", () => {
                // When called with a function and arguments
                // Then it should return the result
                expect(noDeps((x, y) => ({x, y}), 15, 21)).to.deep.equal({x: 15, y: 21});
            });
            it("prevents forming a dependency", () => {
                // Given a cached that peeks at a value via noDeps
                const v = value(42), c = cached(() => noDeps(v));
                // And has a subscriber (so it will only recompute if a dependency changes)
                rule(() => { c() }); runRules();
                expect(c()).to.equal(42);
                // And a value that has changed after it was peeked
                v.set(43);
                // When the cached is called
                // Then it should still have the old value
                expect(c()).to.equal(42);
            });
            it("doesn't prevent cycle detection on assignment", () => {
                // Given a rule that reads and writes a value with noDeps
                const v = value(42);
                rule(() => { noDeps(() => { v.set(v()+1); }); })
                // When the rule is run,
                // Then it should still throw a write conflict
                expect(runRules).to.throw(WriteConflict);
            });
        })
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
            // Then the source should be subscribed
            see("sub", "ping");
            runRules(); see();
            // And when the source produces a value
            changed(); see();
            // Then the rule should update
            runRules(); see("ping");
            // And when the rule is ended
            end()
            // Then the source should be unsubscribed
            see("unsub");
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
            // Then the sources should each be subscribed
            see("sub 1", "ping 1", "sub 2", "ping 2");
            // And when they are updated, the rules should recalc
            o1.cb(); runRules(); see("ping 1");
            o2.cb(); runRules(); see("ping 2");
            // And when ended, they should unsubscribe
            r2(); see("unsub 2");
            r1(); see("unsub 1");
        });
        it("async-throws and kills its job on setup error", () => {
            // Given a source that throws and a rule that references it
            const src: RecalcSource = () => { log("sub"); must(()=> log("unsub")); throw "boom"; }
            const end = rule(() => { recalcWhen(src); log("ping"); });
            // When the rule is run
            runRules();
            // Then the error should async-throw and the subscription should be rolled back
            see("sub", "Uncaught: boom", "unsub", "ping");
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