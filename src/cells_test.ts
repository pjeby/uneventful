import { afterEach, beforeEach, describe, expect, it } from "../dev_deps.ts";
import { current } from "./ambient.ts";
import { bin } from "./bins.ts";
import { runEffects, value, cached, effect } from "./cells.ts";

function setupBin() {
    var b = bin();
    beforeEach(() => { current.bin = b; });
    afterEach(() => { b.cleanup(); current.bin = null; });
}

describe("Cycles and Side-Effects", () => {
    setupBin();
    it("cached() can't create side-effects", () => {
        const v = value(99), w = cached(() => v.set(42));
        expect(w).to.throw("Side-effects not allowed")
    });
    it("effect() can't set a value it reads", () => {
        const v = value(99);
        effect(() => { v.set(v()+1); })
        expect(runEffects).to.throw("Circular update error");
    });
    it("inter-effect loops are detected and killed", () => {
        const v1 = value(99), v2 = value(0);
        const c1 = cached(() => v1()*2);
        effect(() => v2.set(c1()));
        effect(() => { v1.set(v2()); });
        expect(runEffects).to.throw(/cycle detected/)
        runEffects() // nothing happens - first effect is dead
        v2.set(23);
        runEffects();
        expect(v1()).to.equal(23); // second effect still working
    });
    // XXX shouldn't sp.run(), job(), cleanup, and many more from inside cached?
    // don't allow create effect() inside cached?
    // prevent self-dependency in cached()
});


describe("Consistent updates", () => {
    setupBin();
    it("with multiple paths to common element", () => {
        const start = value(22);
        const route1 = cached(() => start() - 1);
        const route2 = cached(() => start() + 1);
        const common = effect(() => log(`${route1()}, ${route2()}`));
        runEffects(); see("21, 23");
        start.set(44);
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
        see("F", "E", "H");
        A.set(3); B.set(1); runEffects();
        see("F", "H");
        A.set(4); B.set(2); runEffects();
        see("F", "E", "H");
    })
});




describe.skip("cached()", () => {});

describe("effect()", () => {
    setupBin();
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

var _log: string[] =[];


function log(s) { _log.push(""+s); }
function see(...lines: Array<string|RegExp>) {
    const data = _log;
    _log = [];
    for (const line of lines) {
        if (typeof line === "string") {
            expect(data.shift()).to.equal(line, `Got ${data.join('\n')}`);
        } else expect(data.shift()).to.match(line, `Got ${data.join('\n')}`);
    }
    expect(data.length).to.equal(0, `Unexpected extra output: ${data.join('\n')}`);
}