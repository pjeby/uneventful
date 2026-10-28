/**
 * Provide access to certain internals (for testing use only)
 *
 * @module
 */

import { batch } from "./scheduling.ts";
import { defer } from "./defer.ts";
import { Context } from "./types.ts";

export const
    /** Containers' asyncCatch handlers: in a map because few tasks will have them */
    catchers = new WeakMap<Context, (this: Context, err: any) => unknown>(),

    /** Default error handler for the root scope */
    defaultCatch = (e: any) => { Promise.reject(e); }
;

/** Contexts' owners (parents) - uses a map so they're not directly accessible */
export const owners = new WeakMap<Context, Context>();

/** Streams that need resuming  */
export const pulls = /* @__PURE__ */ batch<{ doPull(): void; }>(pulls => {
    for (const conn of pulls) { pulls.delete(conn); conn.doPull(); }
}, defer);

/** An optional value @inline */
export type Maybe<T> = T | undefined
