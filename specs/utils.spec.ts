import { describe, expect, it, log, see } from "./dev_deps.ts";
import { GeneratorBase, arrayEq, decorateMethod, isGeneratorFunction } from "../src/utils.ts";

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
    describe("isGeneratorFunction", () => {
        it("detects generator functions", () => {
            expect(isGeneratorFunction(function*(){})).to.be.true
            expect(isGeneratorFunction(function(){})).to.be.false
            expect(isGeneratorFunction(() => {})).to.be.false
        })
    })
    describe("decorateMethod", () => {
        it("Calls the function wrapper when called in TC39 decorator mode", () => {
            // Given a function wrapper using decorateMethod
            // When it is called in TC39 mode with a function to wrap
            const res = arbitraryWrapper(functionToWrap, {kind: "method"})
            // Then the wrapper should be called with just the function
            see("called", "true")
            // And the result should be the wrapper's return value
            expect(res()).to.equal(42)
        })
        it("Calls the function wrapper when called in legacy decorator mode", () => {
            // Given a function wrapper using decorateMethod
            // When it is called in legacy mode with a descriptor
            const desc = {value: functionToWrap, configurable: true}
            const res = arbitraryWrapper(class {} as any, "methodName", desc) as any as typeof desc;
            // Then the wrapper should be called with just the function
            see("called", "true")
            // And the result should be a copied descriptor with the wrapper's return value
            expect(res.value()).to.equal(42)
            expect(res.configurable).to.be.true
        });

        function arbitraryWrapper(fn: () => number, ...args: any[]): () => number {
            if (args.length) return decorateMethod(arbitraryWrapper, fn, ...args as [any, any])
            log("called")
            log(fn === functionToWrap)
            return () => 42
        }

        function functionToWrap() { return 99; }
    });
});
