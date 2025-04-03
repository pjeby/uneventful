import { Job, Yielding } from "./types.ts";
import { start } from "./jobutils.ts";
import { isValue, isError, markHandled } from "./results.ts";
import { isFunction } from "./utils.ts";
import { connect, Source } from "./streams.ts";

export function callOrWait<T>(
    source: any, method: string, handler: (job: Job<T>, val: T) => void, noArgs: (f?: any) => Yielding<T> | void
) {
    if (source && isFunction(source[method])) return source[method]() as Yielding<T>;
    if (!isFunction(source)) mustBeSourceOrSignal();
    return (
        source.length === 0 ? noArgs(source) : false
    ) || start<T>(job => {
        connect(source as Source<T>, v => handler(job, v)).do(r => {
            if (isValue(r)) job.throw(new Error("Stream ended"));
            else if (isError(r)) job.throw(markHandled(r));
        });
    });
}

export function mustBeSourceOrSignal() { throw new TypeError("not a source or signal"); }
