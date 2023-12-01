import { log, see, describe, expect, it, useTracker } from "./dev_deps.ts";
import { runEffects, value, cached, effect, noDeps, WriteConflict } from "../mod.ts";

describe("noDeps()", () => {
    useTracker();
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