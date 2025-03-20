/**
 * Ambient execution context (for job, resource, and dependency tracking)
 *
 * @internal
 * @module
 */

import type { Job } from "./types.ts";
import type { Cell } from "./cells.ts";

/** The current context */
export var currentJob: Job, currentCell: Cell;

/** Context stacks */
const cells = [] as Cell[], jobs = [] as Job[];

/** Set a temporary context */
export function pushCtx(job?: Job | null, cell?: Cell | null) {
    jobs.push(currentJob)
    cells.push(currentCell)
    currentJob = job
    currentCell = cell
}

/** Restore previous context */
export function popCtx() {
    currentJob = jobs.pop()
    currentCell = cells.pop()
}

/** Create a job from the current cell if there's a cell and no job  */
export function cellJob() {
    return currentJob ||= currentCell?.getJob()
}
