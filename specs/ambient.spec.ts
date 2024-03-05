import { describe, it } from "mocha";
import { current, freeCtx, makeCtx, swapCtx } from "../src/ambient.ts";
import { Flow } from "../mod.ts";
import { Cell } from "../src/cells.ts";
import { expect } from "chai";

it("swapCtx() swaps the context", () => {
    const ctx = makeCtx(), old = current;
    expect(old, "Should return the old context").to.equal(swapCtx(ctx));
    expect(ctx, "Should set the passed context").to.equal(current);
    expect(ctx, "Should return the old context").to.equal(swapCtx(old));
    expect(old, "Should set the passed context").to.equal(current);
});

it("makeCtx() creates a context w/given props", () => {
    const c = {} as Cell, f = {} as Flow, ctx = makeCtx(f, c);
    expect(ctx.flow, "Should set flow from first arg" ).to.equal(f);
    expect(ctx.cell, "Should set cell from second arg").to.equal(c);
});

describe("freeCtx()", () => {
    it("Clears the props of the freed context", () => {
        const c = {} as Cell, f = {} as Flow, ctx = makeCtx(f, c);
        freeCtx(ctx);
        expect(ctx.flow, "Should clear the flow").to.equal(null);
        expect(ctx.cell, "Should clear the job").to.equal(null);
    })
    it("Recycles to makeCtx()", () => {
        const ctx = makeCtx();
        freeCtx(ctx);
        expect(makeCtx(), "Should be recycled").to.equal(ctx);
    })
});
