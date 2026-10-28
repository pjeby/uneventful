import { Completion, Yieldable } from "./types.ts";
import { start } from "./jobutils.ts";
import { isValue, isError, markHandled } from "./results.ts";
import { isFunction } from "./utils.ts";
import { connect, Source } from "./streams.ts";

export function callOrWait<T>(
    source: any, method: string, handler: (cpl: Completion<T>, val: T) => void, noArgs: (f?: any) => Yieldable<T> | void
) {
    if (source && isFunction(source[method])) return source[method]() as Yieldable<T>;
    if (!isFunction(source)) mustBeSourceOrSignal();
    return (
        source.length === 0 ? noArgs(source) : false
    ) || start<T>(work => {
        connect(source as Source<T>, v => handler(work, v)).do(r => {
            if (isValue(r)) work.throw(new Error("Stream ended"));
            else if (isError(r)) work.throw(markHandled(r));
        });
    });
}

export function mustBeSourceOrSignal() { throw new TypeError("not a source or signal"); }
