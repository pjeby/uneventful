import { makeCtx, swapCtx } from "./ambient.ts";
import { Request, Suspend, Yielding, reject, resolve } from "./async.ts";
import { defer } from "./defer.ts";
import { getFlow, release } from "./tracking.ts";

export function runGen<R>(g: Yielding<R>, req?: Request<R>) {
    let it = g[Symbol.iterator](), running = true, ctx = makeCtx(getFlow()), ct = 0;
    let done = release(() => {
        req = undefined;
        step("return", undefined);
    });
    // Start asynchronously
    defer(() => { running = false; step("next", undefined); });

    function step(method: "next" | "throw" | "return", arg: any): void {
        if (!it) return;
        // Don't resume a job while it's running
        if (running) {
            return defer(step.bind(null, method, arg));
        }
        const old = swapCtx(ctx);
        try {
            running = true;
            try {
                for(;;) {
                    ++ct;
                    const {done, value} = it[method](arg);
                    if (done) {
                        req && resolve(req, value);
                        req = undefined;
                        break;
                    } else if (typeof value !== "function") {
                        method = "throw";
                        arg = new TypeError("Jobs must yield functions (or yield* Yielding<T>s)");
                        continue;
                    } else {
                        let called = false, returned = false, count = ct;
                        (value as Suspend<any>)((op, val, err) => {
                            if (called) return; else called = true;
                            method = op; arg = op === "next" ? val : err;
                            if (returned && count === ct) step(op, arg);
                        });
                        returned = true;
                        if (!called) return;
                    }
                }
            } catch(e) {
                req ? reject(req, e) : Promise.reject(e);
                req = undefined;
            }
            // Iteration is finished; disconnect from flow
            it = undefined;
            done?.();
            done = undefined;
        } finally {
            swapCtx(old);
            running = false;
        }
    }
}
