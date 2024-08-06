import { describe, expect, it } from "./dev_deps.ts";
import { GeneratorBase, arrayEq, isArray } from "../src/utils.ts";

describe("Utilities", () => {
    describe("arrayEq()", () => {
        it("returns true for equivalent arrays or equal non-arrays", () => {
            const noDeps: any[] = [];
            expect(arrayEq(noDeps, noDeps)).to.be.true;
            expect(arrayEq([1, 2], [1, 2])).to.be.true;
            expect(arrayEq([3, "1", 2], [3, "1", 2])).to.be.true;
            expect(arrayEq(1, 1)).to.be.true;
        });
        it("returns false for different length, different contents, or different non-arrays", () => {
            expect(arrayEq([], undefined)).to.be.false;
            expect(arrayEq(undefined, [1, 2])).to.be.false;
            expect(arrayEq([1], undefined)).to.be.false;
            expect(arrayEq([1], [1, 2])).to.be.false;
            expect(arrayEq([1, 2], [1])).to.be.false;
            expect(arrayEq([1, 2], [1, 3])).to.be.false;
            expect(arrayEq(1, 2)).to.be.false;
        });
    });
    describe("GeneratorBase", () => {
        it("detects generators w/instanceof", () => {
            expect((function*(){})()).to.be.instanceOf(GeneratorBase)
        });
    });
});
