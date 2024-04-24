import { start } from "./tracking.ts";
import { Request, rejecter, resolve, resolver } from "./results.ts"

/**
 * A pausable computation that ultimately produces a value of type T.
 *
 * An item of this type can be used to either create a job of type T, or awaited
 * in a job via `yield *` to obtain the value.
 *
 * Any generator function that ultimately returns a value, implicitly returns a
 * Yielding of that type, but it's best to *explicitly* declare this so that
 * TypeScript can properly type check your yield expressions.  (e.g. `function
 * *(): Yielding<number> {}` for a generator function that ultimately returns a
 * number.)
 *
 * Generator functions implementing this type should only ever `yield *` to
 * things that are of Yielding type, such as a {@link Job}, {@link to}() or
 * other generators declared Yielding.
 *
 * @yields {@link Suspend}\<any>
 * @returns T
 *
 *
 * @category Types and Interfaces
 */
export type Yielding<T> = {
    /**
     * An iterator suitable for use with `yield *` (in a job generator) to
     * obtain a result.
     *
     * @category Obtaining Results
     */
    [Symbol.iterator](): JobIterator<T>
}

/**
 * An iterator yielding {@link Suspend} callbacks.  (An implementation detail of
 * the {@link Yielding} type.)
 *
 * @category Types and Interfaces
 */
export type JobIterator<T> = Generator<Suspend<any>, T, any>

/**
 * An asynchronous operation that can be waited on by a {@link Job}.
 *
 * When a {@link JobIterator} yields a Suspend, the job invokes it with a
 * {@link Request}.  The Suspend function should arrange for the request to be
 * settled (via {@link resolve} or {@link reject}).
 *
 * Note: If the request is not settled, **the job will be suspended until
 * cancelled by outside forces**.  (Such as its enclosing job ending, or
 * explicit throw()/return() calls on the job instance.)
 *
 * Also note that any subjobs the Suspend function creates (or cleanup callbacks
 * it registers) **will not be called until the *calling* job ends**.  So any
 * resources that won't be needed once the job is resumed should be explicitly
 * disposed of -- in which case you should probably just `yield *` to a
 * {@link start}(), instead of yielding a Suspend!
 *
 * @category Types and Interfaces
 */
export type Suspend<T> = (request: Request<T>) => void;


/**
 * Convert a promise to something you can `yield *to()` in a job
 *
 * Much like `await valueOrPromiseLike` in an async function, using `yield
 * *to(valueOrPromiseLike)` in a {@link Job}'s generator function will return
 * the value or the result of the promise/promise-like object.
 *
 * @category Scheduling
 */
export function *to<T>(p: Promise<T> | PromiseLike<T> | T) {
    return yield (res: Request<T>) => Promise.resolve(p).then(resolver(res), rejecter(res));
}

/**
 * Pause the job for the specified time in ms, e.g. `yield *sleep(1000)` to wait
 * one second.
 *
 * @category Scheduling
 */
export function *sleep(ms: number): Yielding<void> {
    try {
        var id: ReturnType<typeof setTimeout>;
        yield r => {
            id = setTimeout(() => { id = undefined; resolve(r, void 0); },  ms);
        }
    } finally {
        if (id) clearTimeout(id);
    }
}
