import { log, see, describe, expect, it, useTracker } from "./dev_deps.ts";
import { runEffects, value, cached, effect } from "../mod.ts";
import { CircularDependency, WriteConflict } from "../src/cells.ts";

describe("Cycles and Side-Effects", () => {
    useTracker();
    it("cached() can't create side-effects", () => {
        const v = value(99), w = cached(() => v.set(42));
        expect(w).to.throw("Side-effects not allowed")
    });
    describe("effect() can't set a value", () => {
        it("after it reads it", () => {
            const v = value(99);
            effect(() => { v.set(v()+1); })
            expect(runEffects).to.throw(CircularDependency);
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
    useTracker();
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




describe.skip("cached()", () => {});

describe("effect()", () => {
    useTracker();
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

describe("effect.root()", () => {
    it("should call the function on tick", () => {
        const dispose = effect.root(() => log("called"));
        try {
            runEffects();
            see("called");
        } finally {
            dispose();
        }
    });
});