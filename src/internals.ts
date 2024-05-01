/**
 * Provide access to certain internals (for testing use only)
 *
 * @module
 */

import { Job } from "./types.ts";

export const
    /** Jobs' asyncCatch handlers: in a map because few jobs will have them */
    catchers = new WeakMap<Job, (this: Job, err: any) => unknown>(),

    /** Default error handler for the `detached` job */
    defaultCatch = (e: any) => { Promise.reject(e); }
;
