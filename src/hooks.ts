import { currentCell } from "./ambient.ts"
import { getCell } from "./cells.ts"
import { arrayEq, setMap } from "./utils.ts"

/**
 * element 0 = current key (or undefined)
 * element 1 - offset to that key's position
 * element 2+ - [key1, ...data1, key2, ...data2, ...]
 */
type HookSet = [current: TemplateStringsArray|null, offset: number, ...data: any[]]

/** @inline */
export type Deps = readonly any[]
const allHooks = new WeakMap<object, HookSet>()
const enum Meta { CURRENT = 0, OFFSET = 1, FIRST = 2 }


// Get the position of the key, or return hooks.length if not found
function indexOf(hooks: HookSet, key: TemplateStringsArray) {
    // Already at cached position?  Return the offset
    if (hooks[Meta.CURRENT] === key) return hooks[Meta.OFFSET]
    // Search forward for the hook from the current position
    let pos = hooks.indexOf(key, hooks[Meta.OFFSET])
    // If not found, and the current position isn't the end of the list, search from the beginning
    if (pos < 0 && hooks[Meta.OFFSET] > Meta.FIRST) pos = hooks.indexOf(key, Meta.FIRST)
    // Update the cached key + position
    hooks[Meta.CURRENT] = key
    return hooks[Meta.OFFSET] = pos < 0 ? hooks.length : pos
}

/**
 * Get or create a hookset for the given context
 * @param ctx any weakrefable object, defaults to the current cell
 * @returns a hookset for the context
 */
export function getHooks(ctx: object = currentCell || getCell("hook-using functions ")) {
    return allHooks.get(ctx) || setMap(allHooks, ctx, [null, Meta.FIRST])
}

/**
 * Look for a TemplateStringsArray in the hooks and optionally allocate space
 * for it, setting the hookset cursor to its location (if found or created).
 *
 * @param [size=0] The number of memo entries to allocate if the memo set
 * doesn't exist yet.  If omitted or zero, no space is allocated.
 *
 * @returns true if key already existed, false otherwise
 */
export function findOrCreateMemos(hooks: HookSet, key: TemplateStringsArray, size = 0) {
    if (indexOf(hooks, key) < hooks.length) return true
    if (size) { hooks.push(key); hooks.length += size; }
    return false
}

/**
 * Fetch an item from the current memo set (as set by {@link findOrCreateMemos}
 * or {@link staleDeps}). Use an offset of 1 for the first item, 2 for the
 * second, etc. up to the number allocated by the size passed to
 * {@link findOrCreateMemos} or {@link staleDeps}.
 */
export function getMemo<T>(hooks: HookSet, offset: number): T {
    return hooks[hooks[Meta.OFFSET] + offset]
}

/**
 * Set an item in the current memo set (as set by {@link findOrCreateMemos}
 * or {@link staleDeps}). Use an offset of 1 for the first item, 2 for the
 * second, etc. up to the number allocated by the size passed to
 * {@link findOrCreateMemos} or {@link staleDeps}.
 */
export function setMemo<T>(hooks: HookSet, offset: number, val: T): T {
    return hooks[hooks[Meta.OFFSET] + offset] = val
}

/**
 * Just like {@link findOrCreateMemos}, but with dependency array checking.  Returns true
 * if the memoset is new or the dependencies don't match.  (Dependencies are stored at
 * offset 1 within the memo set, so store other data beginning at offset 2 and use a
 * size 1 larger than the number of items you need to store.
 */
export function staleDeps(hooks: HookSet, key: TemplateStringsArray, deps?: Deps, size = 2) {
    if (findOrCreateMemos(hooks, key, size) && arrayEq(getMemo(hooks, 1), deps)) return false
    setMemo(hooks, 1, deps)
    return true
}
