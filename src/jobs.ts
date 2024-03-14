import { makeCtx, swapCtx } from "./ambient.ts";
import { Request, Suspend, Yielding, reject, resolve } from "./async.ts";
import { defer } from "./defer.ts";
import { Flow, getFlow, makeFlow, release, start } from "./tracking.ts";

/**
 * Create an asynchronous job and return a new {@link Flow} for it.
 *
 * If *one* argument is given, it should be either a {@link Yielding} object (like
 * a generator), or a no-arguments function returning a Yielding (like a
 * generator function).
 *
 * If *two* arguments are given, the second should be the no-arguments function,
 * and the first is a `this` object the function should be called with.  (This
 * two-argument form is needed since you can't make generator arrows in JS yet.)
 *
 * (Note that TypeScript and/or VSCode may require that you give such a function
 * an explicit `this` parameter (e.g. `job(this, function *(this) {...}));`) in
 * order to correctly infer types inside a generator function.)
 *
 * @returns A new {@link Flow}.
 *
 * @category Flows
 * @category Jobs and Scheduling
 */
export function job<R,T>(thisObj: T, fn: (this:T) => Yielding<R>): Flow<R>
export function job<R>(fn: (this:void) => Yielding<R>): Flow<R>
export function job<R>(g: Yielding<R>): Flow<R>
export function job<R>(g?: Yielding<R> | ((this:void) => Yielding<R>), fn?: () => Yielding<R>): Flow<R> {
    if (g || fn) {
        // Convert g or fn from a function to a yielding
        if (typeof fn === "function") g = fn.call(g); else if (typeof g === "function") g = g();
        // Return existing job or create a new one
        return (g instanceof _Flow) ? g as Flow<R>: start((_, flow) => run(g as Yielding<R>, (m, v, e) => {
            if (m==="next") flow.return(v); else flow.throw(e);
        }));
    }
}

const _Flow = makeFlow().constructor;

function run<R>(g: Yielding<R>, req?: Request<R>) {
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
