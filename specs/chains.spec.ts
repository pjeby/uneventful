import { describe, expect, it } from "./dev_deps.ts";
import { chain, Chain, isEmpty, pop, push, pushCB, shift, unshift, unshiftCB, qlen } from "../src/chains.ts";

function fwd<T>(c: Chain<T>) { const r = []; for(let node = c.n; node !== c; node = node.n) r.push(node.v); return r; }
function rev<T>(c: Chain<T>) { const r = []; for(let node = c.p; node !== c; node = node.p) r.push(node.v); return r; }

describe("Chains", () => {
    describe("chain()", () => {
        it("creates an empty chain", () => {
            // Given a chain
            const c = chain();
            // Then it should be empty
            expect(isEmpty(c)).to.be.true;
            expect(qlen(c)).to.equal(0);
            // And not have any items in it
            expect(fwd(c)).to.deep.equal([]);
            expect(rev(c)).to.deep.equal([]);
        });
    });
    describe("push()", () => {
        it("adds items to the end", () => {
            // Given a chain
            const c = chain<number>();
            // When items are pushed onto it
            push(c, 23);
            // Then it should not be empty
            expect(isEmpty(c)).to.be.false;
            expect(qlen(c)).to.equal(1);
            // And items should be added in order
            push(c, 99);
            expect(qlen(c)).to.equal(2);
            expect(fwd(c)).to.deep.equal([23, 99]);
        });
    });
    describe("pushCB() returns a callback that", () => {
        it("removes the added item", () => {
            // Given a chain with some items added via pushCB
            const c = chain<number>();
            const u1 = pushCB(c, 1), u2 = pushCB(c, 2), u3 = pushCB(c, 3);
            expect(fwd(c)).to.deep.equal([1, 2, 3]);
            expect(qlen(c)).to.equal(3);
            // When a given callback is invoked
            u2();
            // Then the matching item is removed from the chain
            expect(qlen(c)).to.equal(2);
            expect(fwd(c)).to.deep.equal([1, 3]);
            u1();
            expect(qlen(c)).to.equal(1);
            expect(fwd(c)).to.deep.equal([3]);
            u3();
            expect(qlen(c)).to.equal(0);
            expect(fwd(c)).to.deep.equal([]);
            expect(isEmpty(c)).to.be.true;
        });
        it("is idempotent", () => {
            // Given a chain with an item removed via pushCB
            const c = chain<number>();
            const u1 = pushCB(c, 1), u2 = pushCB(c, 2), u3 = pushCB(c, 3);
            u2();
            expect(fwd(c)).to.deep.equal([1, 3]);
            // When the callback is called more than once
            u2();
            // Then it has no effect on the chain
            expect(fwd(c)).to.deep.equal([1, 3]);
            // Even if another item is added and the removal function called again
            push(c, 5); u2();
            expect(fwd(c)).to.deep.equal([1, 3, 5]);
            // And a callback has no effect if the item is removed first
            expect(shift(c)).to.equal(1);
            u1();
            expect(fwd(c)).to.deep.equal([3, 5]);
        });
    });
    describe("unshift()", () => {
        it("adds items to the end", () => {
            // Given a chain
            const c = chain<number>();
            // When items are unshifted onto it
            unshift(c, 23);
            // Then it should not be empty
            expect(qlen(c)).to.equal(1);
            expect(isEmpty(c)).to.be.false;
            // And items should be added in order
            unshift(c, 99);
            expect(qlen(c)).to.equal(2);
            expect(rev(c)).to.deep.equal([23, 99]);
        });
    });
    describe("unshiftCB() returns a callback that", () => {
        it("removes the added item", () => {
            // Given a chain with some items added via unshiftCB
            const c = chain<number>();
            const u1 = unshiftCB(c, 1), u2 = unshiftCB(c, 2), u3 = unshiftCB(c, 3);
            expect(qlen(c)).to.equal(3);
            expect(rev(c)).to.deep.equal([1, 2, 3]);
            // When a given callback is invoked
            u2();
            // Then the matching item is removed from the chain
            expect(qlen(c)).to.equal(2);
            expect(rev(c)).to.deep.equal([1, 3]);
            u1();
            expect(qlen(c)).to.equal(1);
            expect(rev(c)).to.deep.equal([3]);
            u3();
            expect(qlen(c)).to.equal(0);
            expect(rev(c)).to.deep.equal([]);
            expect(isEmpty(c)).to.be.true;
        });
        it("is idempotent", () => {
            // Given a chain with an item removed via unshiftCB
            const c = chain<number>();
            const u1 = unshiftCB(c, 1), u2 = unshiftCB(c, 2), u3 = unshiftCB(c, 3);
            u2();
            expect(rev(c)).to.deep.equal([1, 3]);
            // When the callback is called more than once
            u2();
            // Then it has no effect on the chain
            expect(rev(c)).to.deep.equal([1, 3]);
            // Even if another item is added and the removal function called again
            unshift(c, 5); u2();
            expect(rev(c)).to.deep.equal([1, 3, 5]);
            // And a callback has no effect if the item is removed first
            expect(pop(c)).to.equal(1);
            u1();
            expect(rev(c)).to.deep.equal([3, 5]);
        });
    });
    describe("pop()", () => {
        it("removes items from the end", () => {
            // Given a chain with some items
            const c = chain<number>();
            push(c, 1); push(c, 2); push(c, 3);
            // When items are popped
            expect(pop(c)).to.equal(3);
            // Then they are removed from the end
            expect(qlen(c)).to.equal(2);
            expect(fwd(c)).to.deep.equal([1, 2]);
        });
        it("returns undefined if the chain is empty", () => {
            // Given an empty chain
            const c = chain<number>();
            // When popped
            // Then it should return undefined
            expect(pop(c)).to.be.undefined;
        });
    });
    describe("shift()", () => {
        it("removes items from the beginning", () => {
            // Given a chain with some items
            const c = chain<number>();
            push(c, 1); push(c, 2); push(c, 3);
            // When items are shifted
            expect(shift(c)).to.equal(1);
            // Then they are removed from the front
            expect(qlen(c)).to.equal(2);
            expect(fwd(c)).to.deep.equal([2, 3]);
        });
        it("returns undefined if the chain is empty", () => {
            // Given an empty chain
            const c = chain<number>();
            // When shifted
            // Then it should return undefined
            expect(shift(c)).to.be.undefined;
        });
    });
    describe("isEmpty()", () => {
        it("returns true for null or undefined", () => {
            expect(isEmpty(undefined)).to.be.true;
            expect(isEmpty(null)).to.be.true;
        });
    });
    describe("qlen()", () => {
        it("returns 0 for null or undefined", () => {
            expect(qlen(undefined)).to.equal(0);
            expect(qlen(null)).to.equal(0);
        });
    });
});
