/**
 * Provide access to certain internals (for testing use only)
 *
 * @module
 */

import { makeCtx } from "./ambient.ts";
import { Job } from "./types.ts";

export const
    /** Jobs' asyncCatch handlers: in a map because few jobs will have them */
    catchers = new WeakMap<Job, (this: Job, err: any) => unknown>(),

    /** Default error handler for the `detached` job */
    defaultCatch = (e: any) => { Promise.reject(e); }
;

/** A null context (no job/observer) for cleanups to run in */
export const nullCtx = makeCtx();

/** Jobs' owners (parents) - uses a map so child jobs can't directly access them */
export const owners = new WeakMap<Job, Job>();
