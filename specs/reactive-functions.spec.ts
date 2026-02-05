import { must, noop, start } from "../src/mod.ts"
import { demandChanges } from "../src/cells.ts"
import { cached, fn, fx, rule, runRules, value } from "../src/signals.ts"
import { describe, expect, it, log, see, useRoot } from "./dev_deps.ts"

class Fixture {
    constructor(public name: string) {}

    base = value(1)
    multiplier = value(1)

    @fn getValue() { return this.base() * this.multiplier() }

    monitor = fx(() => { log(`${this.name}: ${this.getValue()}`) })

    @fx activate() {
        log("activating")
        this.monitor()
        must(() => {
            log("deactivated")
        })
    }
}


describe("Reactive Functions", () => {

    const valueFor = fn((f: Fixture) => () => {
        log(`recalc ${f.name}`)
        return `${f.name}: ${f.getValue()}`
    })

    describe("fn()", () => {

        describe("fn(() => T)", () => {
            it("returns a signal", () => {
                const f = fn(() => 42)
                expect(f()).to.equal(42)
                expect(f.value).to.equal(42)
                expect(f).to.be.instanceOf(cached(noop).constructor)
            })
        })

        describe("fn(ob => () => T)", () => {
            it("tracks signal state per object", () => {
                // Given two fixtures and a fn-method accessing them
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                // When it is called with each fixture
                const s1 = valueFor(f1), s2 = valueFor(f2)
                // Then the signals should be called for each object
                see("recalc f1", "recalc f2")
                // And the right value should be returned for each
                expect(s1).to.equal("f1: 1")
                expect(s2).to.equal("f2: 2")
                // And if they are called a second time
                expect(valueFor(f1)).to.equal("f1: 1")
                expect(valueFor(f2)).to.equal("f2: 2")
                // Then there should be no recalculation
                see()
                // Unless a source value changes
                f2.multiplier.set(21)
                // In which case only the affected signal should recalculate
                expect(valueFor(f1)).to.equal("f1: 1")
                expect(valueFor(f2)).to.equal("f2: 42")
                see("recalc f2")
            })
        })

        describe("@fn", () => {
            it("tracks signal state per object", () => {
                // Given two fixtures and a fn-method accessing them,
                // preinitialized to match the current values
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                expect(valueFor(f1)).to.equal("f1: 1")
                expect(valueFor(f2)).to.equal("f2: 2")
                see("recalc f1", "recalc f2")
                // When the upstream values change without changing the @fn
                f2.base.set(1)
                f2.multiplier.set(2)
                // Then the downstream should not recalc
                expect(valueFor(f2)).to.equal("f2: 2")
                see()
            })
        })

        describe("fn``()", () => {
            it("caches signals, keeping state across calls", () => {
                // Given a signal with nested cached signals
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                const s = fn(() => {
                    const s1 = fn``(() => valueFor(f1))
                    const s2 = fn``(() => valueFor(f2))
                    return `${s1()}, ${s2()}`
                })
                expect(s()).to.equal("f1: 1, f2: 2")
                see("recalc f1", "recalc f2")
                // When a dependency is changed
                f1.multiplier.set(3)
                // Then only the affected signal should recalculate
                expect(s()).to.equal("f1: 3, f2: 2")
                see("recalc f1")
            })
            it("caches signal methods, keeping state across calls", () => {
                // Given a signal with a nested cached signal method
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                const s = fn(() => {
                    const vf = fn``((f: Fixture) => () => {
                        log(`recalc ${f.name}`)
                        return `${f.name}: ${f.getValue()}`
                    })
                    return `${vf(f1)}, ${vf(f2)}`
                })
                expect(s()).to.equal("f1: 1, f2: 2")
                see("recalc f1", "recalc f2")
                // When a dependency is changed
                f1.multiplier.set(3)
                // Then only the affected signal should recalculate
                expect(s()).to.equal("f1: 3, f2: 2")
                see("recalc f1")
            })
        })
    })

    describe("fx()", () => {
        useRoot()
        it("only accepts plain functions as effects", () => {
            function shouldThrow(val: (...args: unknown[]) => unknown) {
                const msg="fx() bodies must be plain functions, not signals, generators, or async"
                expect(() => fx(val)).to.throw(msg)
                expect(fx((_: any) => val).bind(null, {})).to.throw(msg)
            }
            shouldThrow(function *(){})
            shouldThrow(async function *(){})
            shouldThrow(fn(() => 42))
        })
        it("persists for the life of a job it's called in", () => {
            // Given a fixture with an fx
            const f1 = new Fixture("f1")
            start(() => {
                // When called within a job
                f1.monitor()
                // Then it should run right away
                see("f1: 1")
                // And when changes are made
                f1.base.set(19)
                see()
                // Then it should run asynchronously on the default queue
                runRules()
                see("f1: 19")
            }).end()
            // And after the job ends
            f1.multiplier.set(2)
            // Then it should no longer run
            runRules()
            see()
        })
        it("ends when no more calling jobs or observing signals", () => {
            // Given a fixture with an fx, referenced three ways
            // (job->fx, job->fx->fx, and rule->fx->fx)
            const f1 = new Fixture("f1")
            const j1 = start(f1.monitor)
            see("f1: 1")
            const j2 = start(() => f1.activate())
            see("activating")
            const r = rule(() => f1.activate())

            // When the signal the fx reads changes
            f1.multiplier.set(23); runRules()
            // Then it should re-run
            see("f1: 23")

            // And when the job->fx ends
            j1.end(); runRules(); see()
            // Then it should still be running
            f1.base.set(2); runRules()
            see("f1: 46")

            // And when the second job ends
            j2.end(); runRules(); see()
            // Then it should still be running
            f1.multiplier.set(21); runRules()
            see("f1: 42")

            // But when the rule also ends
            r(); demandChanges.flush()
            // Then the outer fx should stop
            see("deactivated")

            // And the inner fx should no longer be running
            runRules(); demandChanges.flush()
            f1.multiplier.set(16); runRules()
            see()
        })
        it("runs only in observed signals", () => {
            // Given a signal wrapping an fx
            const f1 = new Fixture("f1")
            const s = fn(() => {log("calculate"); f1.activate()})
            // When the signal is called
            s()
            // Then it should not run the effect
            see("calculate")
            // Until the signal is itself observed by a rule
            const r = rule(s); runRules()
            // And then it should recalc and run the effect
            see("calculate", "activating", "f1: 1")
            // And when the rule ends
            r(); demandChanges.flush()
            // Then it should be deactivated again
            see("deactivated")
            // And when the signal is observed by an effect
            const j = start(fx(() => s()))
            demandChanges.flush(); runRules()
            // Then it should re-activate
            see("calculate", "activating")
            // And when the effect is ended (via its job)
            j.end()
            demandChanges.flush()
            // Then it should deactivate again
            see("deactivated")
        })
        describe("fx``()", () => {
            it("caches effects, keeping state across calls", () => {
                // Given an effect with nested inline effects
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                const s = fx(() => {
                    fx``(() => {log(`recalc f1: ${f1.getValue()}`)})()
                    fx``(() => {log(`recalc f2: ${f2.getValue()}`)})()
                })
                s()
                see("recalc f1: 1", "recalc f2: 2")
                // When a dependency is changed
                f1.multiplier.set(3)
                runRules()
                // Then only the affected effect should rerun
                see("recalc f1: 3")
            })
            it("caches effect methods, keeping state across calls", () => {
                // Given an effect with a nested inline effect method
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                const s = fx(() => {
                    const m = fx``((f: Fixture) => () => { log(`recalc ${f.name}: ${f.getValue()}`) })
                    m(f1)
                    m(f2)
                })
                s()
                see("recalc f1: 1", "recalc f2: 2")
                // When a dependency is changed
                f1.multiplier.set(3)
                runRules()
                // Then only the affected effect should rerun
                see("recalc f1: 3")
            })
        })
        describe("fx(ob => () => void)", () => {
            it("tracks effects per object", () => {
                // Given an effect-method and fixtures to apply it to
                const m = fx((f: Fixture) => () => { log(`recalc ${f.name}: ${f.getValue()}`) })
                const f1 = new Fixture("f1"), f2 = new Fixture("f2")
                f2.base.set(2)
                // When it is applied to each fixture, it should immediately run
                m(f1); see("recalc f1: 1")
                m(f2); see("recalc f2: 2")
                // And changes should be tracked on a per-fixture basis
                f2.multiplier.set(21); runRules()
                see("recalc f2: 42")
                f1.base.set(23); runRules()
                see("recalc f1: 23")
            })
        })
    })
})
