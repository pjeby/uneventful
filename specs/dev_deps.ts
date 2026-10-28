export { describe, it, before, beforeEach, after, afterEach } from "mocha";
export { expect } from "chai";

import { expect } from "chai";
import * as chai from "chai";
import * as sinon from "sinon";
import * as sinon_chai from "sinon-chai";
import * as chaiAsPromised from "chai-as-promised";

chai.use((chaiAsPromised["default"] ?? chaiAsPromised) as Chai.ChaiPlugin);
chai.use((sinon_chai["default"] ?? sinon_chai) as Chai.ChaiPlugin);

export const { spy, mock, createStubInstance } = sinon;

var _log: string[] =[];

/** Add an entry to the log for verification */
export function log(s: any) { _log.push(""+s); }

/** Clear the log without checking its contents */
log.clear = () => { _log.length = 0; }

/** Get log contents */
log.get = () => _log;

/** log() as Event sink */
log.emit = (s: any) => { log(s); return true; };

export function msg(val: any) { return () => log(val); }

/** Verify current log contents (and clear the log) */
export function see(...lines: Array<string|RegExp>) {
    const data = _log.splice(0);
    if (lines.every(line => typeof line === "string")) {
        expect(data).to.deep.equal(lines);
        return
    }
    for (const line of lines) {
        if (typeof line === "string") {
            expect(data.shift()).to.equal(line, `Got ${data.join('\n')}`);
        } else expect(data.shift()).to.match(line, `Got ${data.join('\n')}`);
    }
    expect(data.length).to.equal(0, `Unexpected extra output: ${data.join('\n')}`);
}

/** For waiting a microtask */
export const tick = Promise.resolve();

/** Wait until a certain amount of output is present: WARNING - can loop indefinitely! */
export async function waitAndSee(...args: Array<string|RegExp>) {
    while (log.get().length < args.length) await tick;
    see(...args);
}

import { after, before, reporters } from "mocha";
reporters.Base.colors.pending = 93;

import { newRoot, root } from "../src/tracking.ts";
import { isCancel, isError, isValue, Result } from "../src/results.ts";
import { popCtx, pushCtx } from "../src/ambient.ts";
import { beforeEach, afterEach } from "mocha";
import { setDefer } from "../src/defer.ts";
import { pulls } from "../src/internals.ts";
import { apply, isFunction } from "../src/utils.ts";

/** Flush pulls queue */
export const runPulls = pulls.flush;

/** Arrange for each test in the current suite to be wrapped with a current context */
export function useContext() {
    var f = root.checkpoint();
    beforeEach(() => { pushCtx(f); log.clear(); });
    afterEach(() => { f.reset(); popCtx(); log.clear(); });
}

// Log all unhandled async errors as `Uncaught: X`
export const logUncaught = (e: any) => log(`Uncaught: ${e}`)
root.asyncCatch(logUncaught)

// Log all unhandled rejections as `rejected: X`
const seen = new WeakSet<Promise<any>>();
process.on("unhandledRejection", (e, p) => {
    // Workaround for https://github.com/mochajs/mocha/issues/4743 - don't log 2 rejections for same promise
    if (seen.has(p)) return;
    seen.add(p);
    log(`rejected: ${e}`);
});

export let clock: sinon.SinonFakeTimers;
export const unset: any = undefined

export function useClock() {
    before(() => { clock = sinon.useFakeTimers(new Date); setDefer(f => setTimeout(f, 0)); });
    after(() => { clock.restore(); clock = unset; setDefer(queueMicrotask); });
    afterEach(() => clock?.runAll());
}

export function noClock() {
    after(() => { clock = sinon.useFakeTimers(new Date); setDefer(f => setTimeout(f, 0)); });
    before(() => { clock.restore(); clock = unset; setDefer(queueMicrotask); });
}

chai.use(function ({Assertion}, {addProperty, addMethod}) {
    addProperty(Assertion.prototype, 'canceled', function (this: Chai.AssertionPrototype) {
        this.assert(
            isCancel(this._obj.result())
          , 'expected #{this} to be canceled'
          , 'expected #{this} to not be canceled'
          , true
        );
    })
    addProperty(Assertion.prototype, 'valueResult', function (this: Chai.AssertionPrototype) {
        this.assert(
            isValue(this._obj.result())
          , 'expected #{this} to have a value result'
          , 'expected #{this} to not have a value result'
          , true
        );
    })
    addProperty(Assertion.prototype, 'errorResult', function (this: Chai.AssertionPrototype) {
        this.assert(
            isError(this._obj.result())
          , 'expected #{this} to have an error result'
          , 'expected #{this} to not have an error result'
          , true
        );
    })
    addMethod(Assertion.prototype, "valueResultOf", function (
        this: Chai.AssertionPrototype, value: any
    ) {
        this._obj.should.have.valueResult
        const r = this._obj.result() as Result<any>
        r.should.have.property("val", value)
    })
    addMethod(Assertion.prototype, "errorResultOf", function (
        this: Chai.AssertionPrototype, value: any
    ) {
        this._obj.should.have.errorResult
        const r = this._obj.result() as Result<any>
        (r.err.should as Chai.Assertion).have.property("message", value)
    })
});

declare global {
    namespace Chai {
        interface Assertion {
            canceled: Assertion
            valueResult: Assertion
            errorResult: Assertion
            valueResultOf(value: any): Assertion
            errorResultOf(errmsg: string): Assertion
        }
    }
}

export type Step<T> = (val: T) => void

export const should = chai.should()

afterEach(() => void see())

/**
 * A proxied-for-fluency object whose methods all return the proxy, and which
 * allows arbitrary syntax sugar/"noise word" properties that return the wrapper
 * as well.
 */
export type Fluent<T> = {
    /** The original type, with functions changed to return the `Fluent<T>` */
    [K in keyof T]: T[K] extends (...args: any[]) => infer R ?
        (...args: Parameters<T[K]>) => R extends void ? Fluent<T> : R :
        T[K]
} & {
    /** Noise words/syntax sugar */
    [K in Exclude<string, keyof T>]: Fluent<T>
}

/**
 * Proxy an object for fluent method/property chaining, such that its methods
 * always return the proxy, and any non-existent properties return the proxy
 */
export function fluent<T extends object>(ob: T): Fluent<T> {
    return new Proxy(ob, fluentHandler)
}

const fluentHandler: ProxyHandler<any> = { get(target, prop, receiver) {
    if (prop in target && !(prop in Object.prototype)) {
        const val = target[prop]
        if (isFunction(val)) return (...args: any[]) => {
            const r = apply(val, target, args)
            return r === undefined ? receiver : r
        }
        return val
    }
    return receiver
}}

export class Rig {
    waiting(ms = 0) { clock.tick(ms) }
    newRootIsCalled() { newRoot() }
    theRootIsEnded() { root.end() }

    noOutput() { see() }
    weShouldSee(...lines: string[]) { see(...lines) }

    // Typing fix: we want .should to be a noise word, but Chai installs an
    // Object.prototype.should property.  Declaring it explicitly ensures
    // Fluent doesn't think it's a Chai.Assertion.  And at runtime, the
    // property is skipped due to being in Object.prototype.
    //
    declare should: Fluent<this>
}
