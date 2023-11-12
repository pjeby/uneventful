/**
 * Ambient execution context (for jobs, bins, and dependency tracking)
 *
 * @internal
 * @module
 */

import type { DisposalBin } from "./bins.ts";
import type { Job } from "./types.ts";

type Opt<X> = X | undefined | null;

export type Context = {
    job: Opt<Job<any>>
    bin:  Opt<DisposalBin>
    obs: any
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
    bin?:  Context["bin"],
    obs?:  Context["obs"],
): Context {
    if (freelist && freelist.length) {
        const s = freelist.pop()!;
        s.job = job;
        s.bin = bin;
        s.obs = obs;
        return s;
    }
    return {job, bin, obs};
}

/** Put a no-longer-needed context object on the recycling heap */
export function freeCtx(s: Context) {
    s.job = s.bin = s.obs = null;
    freelist.push(s);
}

