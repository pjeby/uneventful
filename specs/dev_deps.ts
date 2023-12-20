export { describe, it, before, beforeEach, after, afterEach } from "mocha";
export { expect } from "chai";

import { expect } from "chai";
import * as chai from "chai";
import * as sinon from "sinon";
import * as sinon_chai from "sinon-chai";
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

import { flow } from "../src/mod.ts";
import { current } from "../src/ambient.ts";
import { beforeEach, afterEach } from "mocha";
import { setDefer } from "../src/defer.ts";

/** Arrange for each test in the current suite to be wrapped in a root() for cleanup */
export function useRoot() {
    var b = flow();
    beforeEach(() => { current.flow = b; log.clear(); });
    afterEach(() => { b.cleanup(); current.flow = null; log.clear(); });
}

export let clock: sinon.SinonFakeTimers;
export function useClock() {
    before(() => { clock = sinon.useFakeTimers(new Date); setDefer(f => setTimeout(f, 0)); });
    after(() => { clock.restore(); clock = undefined; setDefer(queueMicrotask); });
    afterEach(() => clock.runAll());
}
