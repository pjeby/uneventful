import { describe, it } from "mocha";
import { cellCtx, currentCell, currentCtx, popCtx, pushCtx } from "../src/ambient.ts";
import { root, Context } from "../src/mod.ts";
import { Cell, defaultQ } from "../src/cells.ts";
import { expect } from "chai";

function expectContextCell(ctx?: Context, cell?: Cell) {
    expect(currentCtx).to.equal(ctx);
    expect(currentCell).to.equal(cell);
}

describe("Ambient Context API", () => {
    describe("pushCtx()/popCtx()", () => {
        it("control the currentCell/currentCtx", () => {
            // Given a cell and/or context
            const c = {} as Cell, f = {} as Context;
            // When no context has been pushed,
            // Then there should be no current cell or context
            expectContextCell();
            // But when a context has been pushed
            pushCtx(f, c);
            try {
                // Then the current cell and context should match
                expectContextCell(f, c);
                // Until undefineds are pushed
                pushCtx(undefined, undefined);
                try {
                    // And then the current cell and context should be undefined
                    expectContextCell(undefined, undefined);
                } finally {
                    // Until the context is popped
                    popCtx()
                }
                // And then the pushed cell and context should be current again
                expectContextCell(f, c);
            } finally {
                // Until the outer context is popped
                popCtx()
            }
            // And then they should be undefined again.
            expectContextCell();
        });
    });
    describe("cellCtx() creates a context for the cell", () => {
        it("if cell and no context", () => {
            const c = new Cell; c.setQ(defaultQ)
            // Given a cell and no context on the context stack
            pushCtx(undefined, c)
            try {
                expectContextCell(undefined, c);
                // When cellCtx() is called
                const j = cellCtx()
                // Then it should return the cell.ctx
                expect(j).to.equal(c.ctx)
                //  And it should be a context object
                expect(j).to.be.instanceOf(root.constructor)
                // And it should also be the current context
                expectContextCell(j, c)
            } finally {
                popCtx()
            }
        });
    })
})
