import { Coroutine, Request } from "./types.ts";
import { rejecter, resolve, resolver } from "./results.ts"
import { Maybe } from "./internals.ts";

/**
 * Convert a (possible) promise to something you can `yield *to()` in a coroutine
 *
 * Much like `await valueOrPromiseLike` in an async function, using `yield
 * *to(valueOrPromiseLike)` in a coroutine will return the value or the result
 * of the promise/promise-like object.
 *
 * @category Scheduling
 */
export function *to<T>(p: Promise<T> | PromiseLike<T> | T): Coroutine<T> {
    return yield (res: Request<T>) => Promise.resolve(p).then(resolver(res), rejecter(res));
}

/**
 * Pause for the specified time in ms, e.g. `yield *sleep(1000)` to wait one
 * second.
 *
 * @category Scheduling
 */
export function *sleep(ms: number): Coroutine<void> {
    try {
        var id: Maybe<ReturnType<typeof setTimeout>>;
        yield r => {
            id = setTimeout(() => { id = undefined; resolve(r, void 0); },  ms);
        }
    } finally {
        if (id) clearTimeout(id);
    }
}
