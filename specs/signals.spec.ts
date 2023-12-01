import { log, see, describe, expect, it, useTracker } from "./dev_deps.ts";
import { runEffects, value, cached, effect, noDeps, WriteConflict, Signal, Writable } from "../mod.ts";

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
    useTracker();
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
        function aValueDependedOnByAnEffect<T>(val: T) {
            const v = value(val);
            effect(() => { log(v()); });
            runEffects(); see(`${val}`);
            return v;
        }
        it("ignores set() of the same value", () => {
            // Given a value that's depended on by an effect
            const v = aValueDependedOnByAnEffect(42);
            // When the value is set to the same value
            v.set(42);
            // Then the effect should not run a second time
            runEffects(); see();
        });
        it("ignores .value set to the same value", () => {
            // Given a value that's depended on by an effect
            const v = aValueDependedOnByAnEffect(42);
            // When the value is set to the same value
            v.value = 42;
            // Then the effect should not run a second time
            runEffects(); see();
        });
        it(".readonly() returns a readonly signal", () => {
            // Given a value() and its .readonly() signal
            const val = value(), s = val.readonly();
            // When the value is changed, it should be reflected in the signal
            verifyMulti(v => { val.value = v; return s as Signal<typeof v>; });
            // And the signal should not have a .set() method
            expect(s["set"]).to.be.undefined;
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
    });
});

describe("Dependency tracking", () => {
    useTracker();
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
                effect(() => { c() }); runEffects();
                expect(c()).to.equal(42);
                // And a value that has changed after it was peeked
                v.set(43);
                // When the cached is called
                // Then it should still have the old value
                expect(c()).to.equal(42);
            });
            it("doesn't prevent cycle detection on assignment", () => {
                // Given an effect that reads and writes a value with noDeps
                const v = value(42);
                effect(() => { noDeps(() => { v.set(v()+1); }); })
                // When the effect is run,
                // Then it should still throw a write conflict
                expect(runEffects).to.throw(WriteConflict);
            });
        })
    });
});

describe("Signal invariants", () => {
    useTracker();

    it("Updates are immediate outside of effects", () => {
        // Given a value
        const v = value(42); // Given a value
        // And a cached() of that value
        const c1 = cached(() => v() * 2); // And a cached() of that value
        // And a cached() depending on that cached()
        const c2 = cached(() => c1() * 2);
        // When the value is set outside an effect
        v.set(43);
        // Then all the values should be visibly changed
        expect(v()).to.equal(43);
        expect(c1()).to.equal(86);
        expect(c2()).to.equal(172);
    });

    it("Inter-effect updates appear immediate while effects are executing", () => {
        // Given a value
        const v = value(42);
        // And a cached() of that value
        const c1 = cached(() => v() * 2);
        // And a cached() depending on that cached()
        const c2 = cached(() => c1() * 2);
        // When the value is set inside an effect
        const v2 = value(43);
        effect(() => { v.set(v2()); });
        effect(() => { log(`${v()}, ${c1()}, ${c2()}`); });
        // Then other effects should see only the modified values
        runEffects();
        see("43, 86, 172");
        // Even if repeated
        v2.set(44);
        runEffects();
        see("44, 88, 176");
    });

    describe("Updates run only when needed (once per batch max)", () => {});
    describe("Effects are asynchronous", () => {});
    describe("Cycles result in errors", () => {});
});