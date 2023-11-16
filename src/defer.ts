/** Invoke a no-argument function as a microtask, using queueMicrotask or Promise.resolve().then() */
export const defer: (cb: () => any) => void =
    typeof queueMicrotask === "function" ?
        queueMicrotask :
        (p => (cb: () => any) => p.then(cb))(Promise.resolve());
