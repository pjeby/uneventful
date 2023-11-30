import { describe, it } from "mocha";
import { current, freeCtx, makeCtx, swapCtx } from "../src/ambient.ts";
import { ResourceTracker } from "../mod.ts";
import { Job } from "../src/types.ts";
import { expect } from "chai";

it("swapCtx() swaps the context", () => {
    const ctx = makeCtx(), old = current;
    expect(old, "Should return the old context").to.equal(swapCtx(ctx));
    expect(ctx, "Should set the passed context").to.equal(current);
    expect(ctx, "Should return the old context").to.equal(swapCtx(old));
    expect(old, "Should set the passed context").to.equal(current);
});

it("makeCtx() creates a context w/given props", () => {
    const j = {} as Job<any>, s = {} as ResourceTracker, ctx = makeCtx(j, s);
    expect(ctx.job, "Should set job from first arg" ).to.equal(j);
    expect(ctx.tracker, "Should set bin from second arg").to.equal(s);
});

describe("freeCtx()", () => {
    it("Clears the props of the freed context", () => {
        const j = {} as Job<any>, s = {} as ResourceTracker, ctx = makeCtx(j, s);
        freeCtx(ctx);
        expect(ctx.job, "Should clear the job").to.equal(null);
        expect(ctx.tracker, "Should clear the bin").to.equal(null);
    })
    it("Recycles to makeCtx()", () => {
        const ctx = makeCtx();
        freeCtx(ctx);
        expect(makeCtx(), "Should be recycled").to.equal(ctx);
    })
});
