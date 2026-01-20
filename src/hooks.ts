import { currentCell } from "./ambient.ts"
import { getCell } from "./cells.ts"
import { PlainFunction } from "./types.ts"
import { arrayEq, setMap } from "./utils.ts"

/**
 * element 0 = current call site (or undefined)
 * element 1 - offset to that call site's position
 * element 2+ - [site1, ...data1, site2, ...data2, ...]
 */
type HookSet = [current: CallSite|null, offset: number, ...data: any[]]

/** @inline */
export type Deps = readonly any[]

/** @inline */
export type CallSite = TemplateStringsArray

const allHooks = new WeakMap<object, HookSet>()
const enum Meta { CURRENT = 0, OFFSET = 1, FIRST = 2 }


/**
 * Get the position of the call site's memos, or return hooks.length if not
 * found
 */
function indexOf(hooks: HookSet, site: CallSite) {
    // Already at cached position?  Return the offset
    if (hooks[Meta.CURRENT] === site) return hooks[Meta.OFFSET]
    // Search forward for the hook from the current position
    let pos = hooks.indexOf(site, hooks[Meta.OFFSET])
    // If not found, and the current position isn't the end of the list, search from the beginning
    if (pos < 0 && hooks[Meta.OFFSET] > Meta.FIRST) pos = hooks.indexOf(site, Meta.FIRST)
    // Update the cached key + position
    hooks[Meta.CURRENT] = site
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
 * Look for a call site in the hooks and optionally allocate space for it,
 * setting the hookset cursor to its location (if found or created).
 *
 * @param [size=0] The number of memo entries to allocate if the memo set
 * doesn't exist yet.  If omitted or zero, no space is allocated.
 *
 * @returns true if memos for call site already existed, false otherwise
 */
export function findOrCreateMemos(hooks: HookSet, site: CallSite, size = 0) {
    if (indexOf(hooks, site) < hooks.length) return true
    if (size) { hooks.push(site); hooks.length += size; }
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
export function staleDeps(hooks: HookSet, site: CallSite, deps?: Deps, size = 2) {
    if (findOrCreateMemos(hooks, site, size) && arrayEq(getMemo(hooks, 1), deps)) return false
    setMemo(hooks, 1, deps)
    return true
}

/**
 * Create a once-per-signal version of a function bound to a specific call site
 *
 * Must be called within a signal, with a TemplateStringsArray designating the
 * call site.  If the signal and call site have previously had a perSignal
 * callback invoked for them, the return value of perSignal is just a no-op
 * function that returns the cached value.  Otherwise a wrapper function is
 * returned that checks the cache, and saves the result of calling
 * {@link func `func()`} with any arguments it received.
 *
 * If a {@link name} string is provided, it's used in the error message that will
 * result if either perSignal or its returned callback are invoked outside a
 * signal.
 */
export function perSignal<F extends PlainFunction>(func: F, site: CallSite, name?: string): F {
    const hooks = getHooks(currentCell || getCell(name))
    return findOrCreateMemos(hooks, site) ?
        // Fast path - return a no-op function with the constant result
        // (avoids any dynamic memory allocation)
        getMemo(hooks, 1) :
        // Slow path - needs to receive args to call the function,
        // and then save the closure for future fast path calls
        <F>((...args: any[]) => {
            const hooks = getHooks(currentCell || getCell(name))
            if (findOrCreateMemos(hooks, site, 1)) {
                return getMemo<F>(hooks, 1)()
            } else {
                const result = func(...args)
                setMemo(hooks, 1, () => result)
                return result;
            }
        })
}
