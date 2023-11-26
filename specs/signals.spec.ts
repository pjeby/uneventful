import { log, see, describe, expect, it, useBin } from "./dev_deps.ts";
import { runEffects, value, cached, effect } from "../mod.ts";

describe("Signal invariants", () => {
    useBin();

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

    it("Updates are suspended while effects are executing", () => {
        // Given a value
        const v = value(42);
        // And a cached() of that value
        const c1 = cached(() => v() * 2);
        // And a cached() depending on that cached()
        const c2 = cached(() => c1() * 2);
        // When the value is set inside an effect
        effect(() => { v.set(43); });
        // Then other effects should see the old value(s) first,
        effect(() => { log(`${v()}, ${c1()}, ${c2()}`); });
        runEffects();
        // and get run a second time to see the new values.
        see("42, 84, 168", "43, 86, 172");
    });

    describe("Updates run only when needed (once per batch max)", () => {});
    describe("Effects are asynchronous", () => {});
    describe("Cycles result in errors", () => {});
});