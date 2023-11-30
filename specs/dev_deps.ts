export { describe, it, before, beforeEach, after, afterEach } from "mocha";
export { expect } from "chai";

import { expect } from "chai";
import * as chai from "chai";
import * as sinon from "sinon";
import * as sinon_chai from "sinon-chai";
chai.use((sinon_chai["default"] ?? sinon_chai) as Chai.ChaiPlugin);

export const { spy, mock } = sinon;

var _log: string[] =[];

/** Add an entry to the log for verification */
export function log(s: any) { _log.push(""+s); }

/** Clear the log without checking its contents */
log.clear = function() { _log.length = 0; }

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

import { reporters } from "mocha";
reporters.Base.colors.pending = 93;

import { tracker } from "../src/tracking.ts";
import { current } from "../src/ambient.ts";
import { beforeEach, afterEach } from "mocha";

/** Arrange for each test in the current suite to be wrapped in a tracker() for cleanup */
export function useTracker() {
    var b = tracker();
    beforeEach(() => { current.tracker = b; log.clear(); });
    afterEach(() => { b.cleanup(); current.tracker = null; log.clear(); });
}
