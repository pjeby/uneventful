import { describe, expect, it, log, see } from "./dev_deps.ts"
import { GeneratorBase, arrayEq, call, decorateMethod, isClass, isGeneratorFunction, isPlainFunction, isPlainObject } from "../src/utils.ts"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

describe("Utilities", () => {
    describe("arrayEq()", () => {
        it("returns true for equivalent arrays or equal non-arrays", () => {
            const noDeps: any[] = [];
            expect(arrayEq(noDeps, noDeps)).to.be.true;
            expect(arrayEq([1, 2], [1, 2])).to.be.true;
            expect(arrayEq([3, "1", 2], [3, "1", 2])).to.be.true;
            expect(arrayEq(1, 1)).to.be.true;
        })
        it("returns false for different length, different contents, or different non-arrays", () => {
            expect(arrayEq([], undefined)).to.be.false;
            expect(arrayEq(undefined, [1, 2])).to.be.false;
            expect(arrayEq([1], undefined)).to.be.false;
            expect(arrayEq([1], [1, 2])).to.be.false;
            expect(arrayEq([1, 2], [1])).to.be.false;
            expect(arrayEq([1, 2], [1, 3])).to.be.false;
            expect(arrayEq(1, 2)).to.be.false;
        })
    })
    describe("call() calls a function with", () => {
        "use strict"; // ensure no this
        const someThis = {}
        function logCall(this: any, ...args: any[]) {
            expect(this === undefined || this === someThis, "Unexpected `this`").to.be.true;
            log(this === someThis)
            log(JSON.stringify(args));
        }
        it("no this and no args", () => {
            call(logCall);            see("false", "[]")
            call(logCall, null);      see("false", "[]")
            call(logCall, undefined); see("false", "[]")
        })
        it("no this and args", () => {
            call(logCall, null, 22);      see("false", "[22]");
            call(logCall, null, 33, 156); see("false", "[33,156]");
        })
        it("this and no args", () => {
            call(logCall, someThis); see("true", "[]")
        })
        it("this and args", () => {
            call(logCall, someThis, 22);      see("true", "[22]");
            call(logCall, someThis, 33, 156); see("true", "[33,156]");
        })
    })
    describe("GeneratorBase", () => {
        it("detects generators w/instanceof", () => {
            expect((function*(){})()).to.be.instanceOf(GeneratorBase)
        })
    })
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
    })
    describe("isPlainFunction()", () => {
        it("accepts plain functions, rejects native classes and exotic functions", () => {
            expect(isPlainFunction(literalObject)).to.be.false
            expect(isPlainFunction(anArrowFunc)).to.be.true
            expect(isPlainFunction(aPlainFunc)).to.be.true
            expect(isPlainFunction(aGenfunc)).to.be.false
            expect(isPlainFunction(anAsyncGenFunc)).to.be.false
            expect(isPlainFunction(anAsyncFunc)).to.be.false
            if (realm) {
                expect(isPlainFunction(realm.literalObject)).to.be.false
                expect(isPlainFunction(realm.anArrowFunc)).to.be.true
                expect(isPlainFunction(realm.aPlainFunc)).to.be.true
                expect(isPlainFunction(realm.aGenfunc)).to.be.false
                expect(isPlainFunction(realm.anAsyncGenFunc)).to.be.false
                expect(isPlainFunction(realm.anAsyncFunc)).to.be.false
            }
        })
    })
    describe("isPlainObject()", () => {
        it("returns true for literals, new Object, and Object.create", () => {
            expect(isPlainObject(literalObject)).to.be.true
            expect(isPlainObject(newObject)).to.be.true
            expect(isPlainObject(created)).to.be.true
            if (realm) {
                expect(isPlainObject(realm.literalObject)).to.be.true
                expect(isPlainObject(realm.newObject)).to.be.true
                expect(isPlainObject(realm.created)).to.be.true
            }
        })
        it("returns false for non-plain objects", () => {
            expect(isPlainObject(new aClass)).to.be.false
            expect(isPlainObject(Promise.resolve(42))).to.be.false
            if (realm) {
                expect(isPlainObject(new realm.aClass)).to.be.false
            }
        })
        it("returns false for non-objects", () => {
            expect(isPlainObject(42)).to.be.false
            expect(isPlainObject(aPlainFunc)).to.be.false
            expect(isPlainObject(null)).to.be.false
            if (realm) {
                expect(isPlainObject(realm.aPlainFunc)).to.be.false
            }
        })
    })
    describe("isClass()", () => {
        it("returns true for ES5 and ES6 classes", () => {
            expect(isClass(aClass)).to.be.true
            expect(isClass(ES5BaseWithMethods)).to.be.true
            expect(isClass(ES5Subclass)).to.be.true
            if (realm) {
                expect(isClass(realm.aClass)).to.be.true
                expect(isClass(realm.ES5BaseWithMethods)).to.be.true
                expect(isClass(realm.ES5Subclass)).to.be.true
            }
        })
        it("returns true for native constructors", () => {
            expect(isClass(Promise)).to.be.true
            expect(isClass(Function)).to.be.true
            expect(isClass(Object)).to.be.true
        })
        it("returns false for functions", () => {
            expect(isClass(anArrowFunc)).to.be.false
            expect(isClass(aPlainFunc)).to.be.false
            expect(isClass(aGenfunc)).to.be.false
            expect(isClass(anAsyncGenFunc)).to.be.false
            expect(isClass(anAsyncFunc)).to.be.false
            if (realm) {
                expect(isClass(realm.anArrowFunc)).to.be.false
                expect(isClass(realm.aPlainFunc)).to.be.false
                expect(isClass(realm.aGenfunc)).to.be.false
                expect(isClass(realm.anAsyncGenFunc)).to.be.false
                expect(isClass(realm.anAsyncFunc)).to.be.false
            }
        })
        it("returns false for non-functions", () => {
            expect(isClass({})).to.be.false
            expect(isClass(null)).to.be.false
            expect(isClass(42)).to.be.false
        })
    })
})

/** Objects from a foreign realm */
const realm = (() => {
    try {
        const vm = require("node:vm") as typeof import("node:vm")
        const code = readFileSync("specs/utils.spec.ts", "utf-8").split("// ==== Fixtures ====\n").pop()
        const ctx = {}
        vm.runInNewContext(code!, ctx)
        expect(Object.keys(ctx)).to.deep.equal([
            'anAsyncFunc', 'anAsyncGenFunc', 'aGenfunc', 'aPlainFunc', 'ES5BaseWithMethods',
            'ES5Subclass', 'anArrowFunc', 'aClass', 'literalObject', 'newObject', 'created'
        ])
        return ctx as any
    } catch (e) {
        console.warn("error setting up vm module; skipping realm-related tests")
        console.error(e)
    }
})()

// ==== Fixtures ====
async function anAsyncFunc() {}
async function *anAsyncGenFunc() {}
function *aGenfunc() {}
function aPlainFunc() {}
var anArrowFunc = () => {}
var aClass = (class aClass {})

function ES5BaseWithMethods() {}
ES5BaseWithMethods.prototype.aMethod = function aMethod() {}

function ES5Subclass () {}
Object.setPrototypeOf(ES5Subclass.prototype, ES5BaseWithMethods.prototype)

var literalObject = {}, newObject = new Object, created = Object.create(null)
