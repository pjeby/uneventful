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

import { detached, isCancel, makeJob } from "../src/mod.ts";
import { popCtx, pushCtx } from "../src/ambient.ts";
import { beforeEach, afterEach } from "mocha";
import { setDefer } from "../src/defer.ts";
import { pulls } from "../src/internals.ts";

/** Flush pulls queue */
export const runPulls = pulls.flush;

/** Arrange for each test in the current suite to be wrapped in a root job */
export function useRoot() {
    var f = makeJob();
    beforeEach(() => { pushCtx(f); log.clear(); });
    afterEach(() => { f.restart(); popCtx(); log.clear(); });
}

// Log all unhandled job errors as `Uncaught: X`
export const logUncaught = (e: any) => log(`Uncaught: ${e}`)
detached.asyncCatch(logUncaught);

// Log all unhandled rejections as `rejected: X`
const seen = new WeakSet<Promise<any>>();
process.on("unhandledRejection", (e, p) => {
    // Workaround for https://github.com/mochajs/mocha/issues/4743 - don't log 2 rejections for same promise
    if (seen.has(p)) return;
    seen.add(p);
    log(`rejected: ${e}`);
});

export let clock: sinon.SinonFakeTimers;
export function useClock() {
    before(() => { clock = sinon.useFakeTimers(new Date); setDefer(f => setTimeout(f, 0)); });
    after(() => { clock.restore(); clock = undefined; setDefer(queueMicrotask); });
    afterEach(() => clock?.runAll());
}

export function noClock() {
    after(() => { clock = sinon.useFakeTimers(new Date); setDefer(f => setTimeout(f, 0)); });
    before(() => { clock.restore(); clock = undefined; setDefer(queueMicrotask); });
}

chai.use(function ({Assertion}, {flag, addProperty}) {
    addProperty(Assertion.prototype, 'canceled', function (this: Chai.AssertionPrototype) {
        this.assert(
            isCancel(this._obj.result())
          , 'expected #{this} to be canceled'
          , 'expected #{this} to not be canceled'
          , true
        );
      })
});

declare global {
    namespace Chai {
        interface Assertion {
            canceled: Assertion
        }
    }
}
