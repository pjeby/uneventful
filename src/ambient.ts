/**
 * Ambient execution context (for job, resource, and dependency tracking)
 *
 * @internal
 * @module
 */

import type { Job } from "./types.ts";
import type { Cell } from "./cells.ts";
import { Maybe } from "./internals.ts";

/** The current context.  A cell of `false` means "don't allow reading reactive values" */
export var currentJob: Maybe<Job> | undefined, currentCell: Maybe<Cell | false>;

/** Context stacks */
const cells = [] as Maybe<Cell | false>[], jobs = [] as Maybe<Job>[];

/** Set a temporary context */
export function pushCtx(job?: Maybe<Job>, cell?: Maybe<Cell | false>) {
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
    return currentJob ||= (currentCell ? currentCell.getJob() : undefined)
}
