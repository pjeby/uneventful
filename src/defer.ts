/**
 * Invoke a no-argument function as a microtask, using queueMicrotask or Promise.resolve().then()
 *
 * @category Scheduling
 */
export let defer: (cb: () => any) => void =
    typeof queueMicrotask === "function" ?
        queueMicrotask :
        (p => (cb: () => any) => p.then(cb))(Promise.resolve());

/**
 * @internal For testing use only!
 *
 */
export function setDefer(fn: typeof defer) {
    defer = fn;
}