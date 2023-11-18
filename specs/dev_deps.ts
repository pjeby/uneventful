export { describe, it, before, beforeEach, after, afterEach } from "mocha";
export { expect } from "chai";

import { expect } from "chai";
import * as chai from "chai";
import * as sinon from "sinon";
import * as sinon_chai from "sinon-chai";
chai.use((sinon_chai["default"] ?? sinon_chai) as Chai.ChaiPlugin);

export const { spy, mock } = sinon;

var _log: string[] =[];

export function log(s: any) { _log.push(""+s); }

log.clear = function() { _log.length = 0; }

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
