import { getHooks, getMemo, findOrCreateMemos, setMemo, staleDeps, Deps } from "../src/hooks.ts";
import { cached, value } from "../src/signals.ts";
import { describe, expect, it, log, see } from "./dev_deps.ts";

function tsa(t: TemplateStringsArray) { return t }

describe("Hooks API", () => {
    describe("getHooks()", () => {
        it("tracks hooksets by context", () => {
            // Given two contexts
            const c1 = {}, c2 = {}
            // When getMemo() is called on them more than once
            const h1 = getHooks(c1), h2 = getHooks(c2)
            const h1a = getHooks(c1), h2a = getHooks(c2)
            // Then the same result should be returned for the same context
            expect(h1).to.equal(h1a)
            expect(h2).to.equal(h2a)
            // And different results for different contexts
            expect(h1).to.not.equal(h2)
        })
        it("defaults to using current cell as context", () => {
            // Given multiple signals depdending on a counter and returning their hooks
            const ctr = value(0), s1 = cached(get), s2 = cached(get)
            function get() { log(ctr()); return getHooks() }
            // When each signal is called
            const h1 = s1(), h2 = s2(); see("0", "0")
            // Then different hooks should be returned
            expect(h1).to.not.equal(h2)
            // And even if the counter changes
            ++ctr.value
            // The same hooks should be returned for each signal
            expect(s1()).to.equal(h1); see("1")
            expect(s2()).to.equal(h2); see("1")
            // And when called outside a signal
            // Then getHooks() with no context should fail
            expect(getHooks).to.throw(/hook-using functions must be called from a reactive expression/)
        })
    })
    describe("findOrCreateMemos()", () => {
        it("Tracks memo states and creates them on request", () => {
            // Given a hook set and 2 TSAs
            const hooks = getHooks({}), t1 = tsa``, t2 = tsa``
            // When findOrCreateMemos() is called for each TSA
            // Then it shoud return false
            expect(findOrCreateMemos(hooks, t1)).to.be.false
            expect(findOrCreateMemos(hooks, t2)).to.be.false
            // Until a memo is created for one of them
            expect(findOrCreateMemos(hooks, t2, 1)).to.be.false
            // And then it should return true for that one
            expect(findOrCreateMemos(hooks, t1)).to.be.false
            expect(findOrCreateMemos(hooks, t2)).to.be.true
            // And when a memo is created for the other
            expect(findOrCreateMemos(hooks, t1, 1)).to.be.false
            // Then it should return true for both
            expect(findOrCreateMemos(hooks, t1)).to.be.true
            expect(findOrCreateMemos(hooks, t2)).to.be.true
        })
    })
    describe("setMemo() and getMemo()", () => {
        it("manage state entries for a given TSA", () => {
            // Given a hook set and 2 TSAs with 2 allocated memos
            const hooks = getHooks({}), t1 = tsa``, t2 = tsa``
            expect(findOrCreateMemos(hooks, t1, 2)).to.be.false
            setMemo(hooks, 1, 42)
            setMemo(hooks, 2, 99)
            expect(findOrCreateMemos(hooks, t2, 2)).to.be.false
            setMemo(hooks, 1, 67)
            setMemo(hooks, 2, 68)
            // When getMemo() is called on the values
            // Then the saved values should be returned
            expect(findOrCreateMemos(hooks, t1)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(42)
            expect(getMemo(hooks, 2)).to.equal(99)
            expect(findOrCreateMemos(hooks, t2)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(67)
            expect(getMemo(hooks, 2)).to.equal(68)
        })
    })
    describe("staleDeps()", () => {
        it("tracks and updates dependency arrays", () => {
            // Given a hook set and 2 TSAs
            const hooks = getHooks({}), t1 = tsa``, t2 = tsa``
            // When staleDeps is called with 0 size for each TSA
            // Then it should return true
            expect(staleDeps(hooks, t1, undefined, 0)).to.be.true
            expect(staleDeps(hooks, t2, undefined, 0)).to.be.true
            // And the memos should not yet exist
            expect(findOrCreateMemos(hooks, t1)).to.be.false
            expect(findOrCreateMemos(hooks, t2)).to.be.false
            // But when called with a size and deps
            const d1 = [1] as Deps, d2 = [2] as Deps
            expect(staleDeps(hooks, t1, d1, 2)).to.be.true
            expect(staleDeps(hooks, t2, d2, 2)).to.be.true
            // Then the memos should exist and have the deps in the first memo
            expect(findOrCreateMemos(hooks, t1)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(d1)
            expect(findOrCreateMemos(hooks, t2)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(d2)
            // And when equivalent deps are used
            const d1a = [1] as Deps, d2a = [2] as Deps
            // Then calls to staleDeps should return false
            // And the first memos should remain the same
            expect(staleDeps(hooks, t1, d1a)).to.be.false
            expect(getMemo(hooks, 1)).to.equal(d1)
            expect(staleDeps(hooks, t2, d2a)).to.be.false
            expect(getMemo(hooks, 1)).to.equal(d2)
            // But if non-equivalent deps are used
            // Then calls to staleDeps should return true
            // And the first memos should be updated
            expect(staleDeps(hooks, t1, d2a)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(d2a)
            expect(staleDeps(hooks, t2, d1a)).to.be.true
            expect(getMemo(hooks, 1)).to.equal(d1a)
        })
    })
})
