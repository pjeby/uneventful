/**
 * Provide access to certain internals (for testing use only)
 *
 * @module
 */

import { batch } from "./scheduling.ts";
import { defer } from "./defer.ts";
import { Job } from "./types.ts";

export const
    /** Jobs' asyncCatch handlers: in a map because few jobs will have them */
    catchers = new WeakMap<Job, (this: Job, err: any) => unknown>(),

    /** Default error handler for the root job */
    defaultCatch = (e: any) => { Promise.reject(e); }
;

/** Jobs' owners (parents) - uses a map so child jobs can't directly access them */
export const owners = new WeakMap<Job, Job>();

/** Streams that need resuming  */
export const pulls = /* @__PURE__ */ batch<{ doPull(): void; }>(pulls => {
    for (const conn of pulls) { pulls.delete(conn); conn.doPull(); }
}, defer);
