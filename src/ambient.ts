/**
 * Ambient execution context (for job, resource, and dependency tracking)
 *
 * @internal
 * @module
 */

import type { Job } from "./tracking.ts";
import type { Cell } from "./cells.ts";

type Opt<X> = X | undefined | null;

export type Context = {
    job: Opt<Job<unknown>>
    cell: Opt<Cell>
}

/** The current context */
export var current: Context = makeCtx();


/** Set a new current context, returning the old one */
export function swapCtx(future: Context): Context {
    const now = current;
    current = future;
    return now
}

var freelist = [] as Context[];

/** Get a fresh context object (either by creation or recycling) */
export function makeCtx(
    job?:  Context["job"],
    cell?: Context["cell"],
): Context {
    if (freelist && freelist.length) {
        const s = freelist.pop()!;
        s.job = job;
        s.cell = cell;
        return s;
    }
    return {job, cell};
}

/** Put a no-longer-needed context object on the recycling heap */
export function freeCtx(s: Context) {
    s.job = s.cell = null;
    freelist.push(s);
}

