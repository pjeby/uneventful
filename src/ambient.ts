/**
 * Ambient execution context (for task, resource, and dependency tracking)
 *
 * @internal
 * @module
 */

import type { Context } from "./types.ts";
import type { Cell } from "./cells.ts";
import { Maybe } from "./internals.ts";

/** The current context.  A cell of `false` means "don't allow reading reactive values" */
export var currentCtx: Maybe<Context>, currentCell: Maybe<Cell | false>;

/** Context stacks */
const cells = [] as Maybe<Cell | false>[], contexts = [] as Maybe<Context>[];

/** Set a temporary context */
export function pushCtx(ctx?: Maybe<Context>, cell?: Maybe<Cell | false>) {
    contexts.push(currentCtx)
    cells.push(currentCell)
    currentCtx = ctx
    currentCell = cell
}

/** Restore previous context */
export function popCtx() {
    currentCtx = contexts.pop()
    currentCell = cells.pop()
}

/** Create a context from the current cell if there's a cell and no context  */
export function cellCtx() {
    return currentCtx ||= (currentCell ? currentCell.getContext() : undefined)
}
