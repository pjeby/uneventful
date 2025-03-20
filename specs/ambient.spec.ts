import { describe, it } from "mocha";
import { cellJob, currentCell, currentJob, popCtx, pushCtx } from "../src/ambient.ts";
import { root, Job } from "../src/mod.ts";
import { Cell } from "../src/cells.ts";
import { expect } from "chai";

function expectJobCell(job?: Job, cell?: Cell) {
    expect(currentJob).to.equal(job);
    expect(currentCell).to.equal(cell);
}

describe("Ambient Context API", () => {
    describe("pushCtx()/popCtx()", () => {
        it("control the currentCell/currentJob", () => {
            // Given a cell and/or job
            const c = {} as Cell, f = {} as Job;
            // When no context has been pushed,
            // Then there should be no current cell or job
            expectJobCell();
            // But when a context has been pushed
            pushCtx(f, c);
            try {
                // Then the current cell and job should match
                expectJobCell(f, c);
                // Until nulls are pushed
                pushCtx(null, null);
                try {
                    // And then the current cell and job should be null
                    expectJobCell(null, null);
                } finally {
                    // Until the context is popped
                    popCtx()
                }
                // And then the pushed cell and job should be current again
                expectJobCell(f, c);
            } finally {
                // Until the outer context is popped
                popCtx()
            }
            // And then they should be undefined again.
            expectJobCell();
        });
    });
    describe("cellJob() creates a job for the cell", () => {
        it("if cell and no job", () => {
            const c = new Cell;
            // Given a cell and no job on the context stack
            pushCtx(undefined, c)
            try {
                expectJobCell(undefined, c);
                // When cellJob() is called
                const j = cellJob()
                // Then it should return the cell.job
                expect(j).to.equal(c.job)
                //  And it should be a job object
                expect(j).to.be.instanceOf(root.constructor)
                // And it should also be the current job
                expectJobCell(j, c)
            } finally {
                popCtx()
            }
        });
    })
})
