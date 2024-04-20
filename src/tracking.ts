/**
 * A cleanup function is a callback invoked when a flow is ended or restarted.
 * It receives a result that indicates whether the flow ended itself with a return
 * value or error, or was canceled/restarted by its creator.
 *
 * @category Types and Interfaces
 */
export type CleanupFn<T=any> = (res?: FlowResult<T>) => unknown;

/**
 * A function that can be called to dispose of something or unsubscribe
 * something.  It's called without arguments and returns void.
 *
 * @category Types and Interfaces
 */
export type DisposeFn = () => void;

/**
 * An optional cleanup parameter or return.
 *
 * @category Types and Interfaces
 */
export type OptionalCleanup<T=any> = CleanupFn<T> | Nothing;

/**
 * An asynchronous start function must return a {@link Yielding}-compatible
 * object, such as a flow or generator.  The returned iterator will be run
 * asynchronously, in the context of the newly-started flow.  Any result it
 * returns or error it throws will be treated as the result of the flow.  If the
 * flow is canceled, the iterator's `.return()` method will be called to abort
 * it (thereby running any try-finally clauses in the generator), and the result
 * of the call will be otherwise ignored.
 *
 * @category Types and Interfaces
 */
export type AsyncStart<T,C=void> = (this: C, job: Flow<T>) => Yielding<T>;

/**
 * A synchronous start function can return void or a {@link CleanupFn}. It runs
 * immediately and gets passed the newly created flow as its first argument.
 *
 * @category Types and Interfaces
 */
export type SyncStart<T,C=void>  = (this: C, job: Flow<T>) => OptionalCleanup<T>;

/**
 * A synchronous or asynchronous initializing function for use with the
 * {@link start}() function or a flow's {@link Flow.start .start}() method.
 *
 * @category Types and Interfaces
 */
export type Start<T,C=void> = AsyncStart<T,C> | SyncStart<T,C>

/**
 * A cancellable asynchronous operation with automatic resource cleanup.
 *
 * You can add cleanup callbacks to a flow via {@link must}() or its
 * {@link .must}() method.  When the flow is ended or canceled, the callbacks
 * are (synchronously) run in reverse order -- a bit like a delayed and
 * distributed collection of `finally` blocks.
 *
 * Flows implement the Promise interface (then, catch, and finally) so they can
 * be passed to Promise-using APIs or awaited by async functions.  They also
 * implement {@link Yielding}, so you can await their results from a
 * {@link start}() using `yield *`.  They also have
 * {@link Flow.return \.return()} and {@link Flow.throw \.throw()} methods so
 * you can end a flow with a result or error.
 *
 * Most flows, however, are not intended to produce results, and are merely
 * canceled (using {@link Flow.end \.end()} or
 * {@link Flow.restart \.restart()}).
 *
 * Flows can be created and accessed using {@link start}(),
 * {@link detached}.start(), {@link makeFlow}(), and {@link getFlow}().
 *
 * @category Types and Interfaces
 */
export interface Flow<T=any> extends Yielding<T>, Promise<T> {
    /**
     * The result of the flow (canceled, returned value, or error), or
     * undefined if the flow isn't finished.
     */
    result(): FlowResult<T> | undefined;

    /**
     * Add a cleanup callback to be run when the flow is ended or restarted.
     * (Non-function values are ignored.)  If the flow has already ended,
     * the callback will be invoked asynchronously in the next microtask.
     */
    must(cleanup?: OptionalCleanup<T>): this;

    /**
     * Like {@link Flow.must}, except a function is returned that will *remove*
     * the cleanup function from the flow, if it's still present. (Also, the
     * cleanup function isn't optional.)
     */
    release(cleanup: CleanupFn<T>): () => void;

    /**
     * Start a nested flow using the given function (or {@link Yielding}). (Like
     * {@link start}, but using a specific flow as the parent, rather than
     * whatever flow is active.  Zero, one, and two arguments are supported,
     * just as with start().)
     */
    start<T>(fn?: Start<T>|Yielding<T>): Flow<T>;
    start<T,C>(ctx: C, fn: Start<T,C>): Flow<T>;

    /**
     * Invoke a function with this flow as the active one, so that calling the
     * global {@link must} function will add cleanup callbacks to it,
     * {@link getFlow} will return it, etc.  (Note: signal dependency tracking
     * is disabled for the duration of the call.)
     *
     * @param fn The function to call
     * @param args The arguments to call it with, if any
     * @returns The result of calling fn(...args)
     */
    run<F extends PlainFunction>(fn?: F, ...args: Parameters<F>): ReturnType<F>

    /**
     * Wrap a function so this flow will be active when it's called.
     *
     * @param fn The function to wrap
     *
     * @returns A function with the same signature(s), but will have this flow
     * active when called.
     *
     * @remarks Note that if the supplied function has any custom properties,
     * they will *not* be available on the returned function at runtime, even
     * though TypeScript will act as if they are present at compile time.  This
     * is because the only way to copy all overloads of a function signature is
     * to copy the exact type (as TypeScript has no way to generically say,
     * "this a function with all the same overloads, but none of the
     * properties").
     */
    bind<F extends (...args: any[]) => any>(fn: F): F

    /**
     * Release all resources held by the flow.
     *
     * All added cleanup functions will be called in last-in-first-out order,
     * removing them in the process.
     *
     * If any callbacks throw exceptions, they're converted to unhandled promise
     * rejections (so that all of them will be called, even if one throws an
     * error).
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another flow, event handler, etc.
     */
    readonly end: () => void;

    /**
     * Restart this flow - works just like {@link Flow.end}, except that the flow
     * isn't ended, so cleanup callbacks can be added again and won't be invoked
     * until the next restart or the flow is ended.
     *
     * Note: this method is a bound function, so you can pass it as a callback
     * to another flow, event handler, etc.
     */
    restart(): this;

    /**
     * End the flow with a thrown error, passing an {@link ErrorResult} to the
     * cleanup callbacks.  (Throws an error if the flow is already ended or is
     * currently restarting.)
     */
    throw(err: any): this;

    /**
     * End the flow with a return value, passing a {@link ValueResult} to the
     * cleanup callbacks.  (Throws an error if the flow is already ended or is
     * currently restarting.)
     */
    return(val: T) : this;

}

import { makeCtx, current, freeCtx, swapCtx } from "./ambient.ts";
import { AnyFunction, Nothing, PlainFunction } from "./types.ts";
import { defer } from "./defer.ts";
import type { Yielding, Suspend } from "./async.ts";
import { FlowResult, ErrorResult, CancelResult, isCancel, ValueResult, isError, isValue, noop } from "./results.ts";
import { resolve, type Request, reject } from "./results.ts";
import { chain, isEmpty, pop, push, pushCB } from "./chains.ts";

/**
 * Return the currently-active Flow, or throw an error if none is active.
 *
 * (You can check if a flow is active first using {@link isFlowActive}().)
 *
 * @category Flows
 */
export function getFlow() {
    const {flow} = current;
    if (flow) return flow;
    throw new Error("No flow is currently active");
}

const nullCtx = makeCtx();

class _Flow<T> implements Flow<T> {
    /** @internal */
    static create<T,R>(parent?: Flow<R>, stop?: CleanupFn<R>): Flow<T> {
        const flow = new _Flow<T>;
        if (parent || stop) flow.must(
            (parent || getFlow()).release(stop || flow.end)
        );
        return flow;
    }

    "uneventful/ext": {} = undefined

    result() { return this._done; }

    get [Symbol.toStringTag]() { return "Flow"; }

    end = () => {
        const res = (this._done ||= CancelResult), cbs = this._cbs, old = swapCtx(nullCtx);
        while (!isEmpty(cbs)) try { pop(cbs)(res); } catch (e) { Promise.reject(e); }
        swapCtx(old);
    }

    restart() {
        this._end(CancelResult); this._done = undefined; return this;
    }

    _end(res: FlowResult<T>) {
        if (this._done) throw new Error("Flow already ended");
        this._done = res;
        this.end();
        return this;
    }

    throw(err: any) { return this._end(ErrorResult(err)); }
    return(val: T)  { return this._end(ValueResult(val)); }

    then<T1=T, T2=never>(
        onfulfilled?: (value: T) => T1 | PromiseLike<T1>,
        onrejected?: (reason: any) => T2 | PromiseLike<T2>
    ): Promise<T1 | T2> {
        var p = new Promise<T>((res, rej) => {
            if (this._done) toPromise(this._done); else this.must(toPromise);
            function toPromise(r: FlowResult<T>) {
                // XXX mark error handled
                if (isError(r)) rej(r.err); else if (isValue(r)) res(r.val); else rej(r);
            }
        })
        return (onfulfilled || onrejected) ? p.then(onfulfilled, onrejected) : p as any;
    }

    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
        return this.then(undefined, onrejected);
    }

    finally(onfinally?: () => void): Promise<T> {
        return this.then().finally(onfinally);
    }

    *[Symbol.iterator]() {
        if (this._done) {
            if (isValue(this._done)) return this._done.val;
            throw isError(this._done) ? this._done.err : this._done;
        } else return yield (req: Request<T>) => {
            // XXX should this be a release(), so if the waiter dies we
            // don't bother? The downside is that it'd have to be mutual and
            // the resume is a no-op anyway in that case.
            this.must(res => {
                if (isCancel(res)) req("throw", undefined, res); else req(res.op, res.val, res.err);
            });
        }
    }

    start<T>(fn?: Start<T>|Yielding<T>): Flow<T>;
    start<T,C>(ctx: C, fn: Start<T,C>): Flow<T>;
    start<T,C>(fnOrCtx: Start<T>|Yielding<T>|C, fn?: Start<T,C>) {
        if (!fnOrCtx) return makeFlow(this);
        let init: Start<T,C>;
        if (typeof fn === "function") {
            init = fn.bind(fnOrCtx as C);
        } else if (typeof fnOrCtx === "function") {
            init = fnOrCtx as Start<T,C>;
        } else if (fnOrCtx instanceof _Flow) {
            return fnOrCtx;
        } else if (typeof fnOrCtx[Symbol.iterator] === "function") {
            init = () => fnOrCtx as Yielding<T>;
        } else {
            // XXX handle promises or other things here?
            throw new TypeError("Invalid argument for start()");
        }
        const flow = makeFlow<T>(this);
        try {
            const result = flow.run(init as Start<T>, flow);
            if (typeof result === "function") return flow.must(result);
            if (result && typeof result[Symbol.iterator] === "function") {
                flow.run(runGen, result, <Request<T>>((m, v, e) => {
                    if (flow.result()) return;
                    if (m==="next") flow.return(v); else flow.throw(e);
                }));
            }
            return flow;
        } catch(e) {
            flow.end();
            throw e;
        }
    }

    protected constructor() {};

    run<F extends PlainFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
        const old = swapCtx(makeCtx(this));
        try { return fn.apply(null, args); } finally { freeCtx(swapCtx(old)); }
    }

    bind<F extends (...args: any[]) => any>(fn: F): F {
        const flow = this;
        return <F> function () {
            const old = swapCtx(makeCtx(flow));
            try { return fn.apply(this, arguments as any); } finally { freeCtx(swapCtx(old)); }
        }
    }

    must(cleanup?: OptionalCleanup<T>) {
        if (typeof cleanup === "function") push(this._chain(), cleanup);
        return this;
    }

    release(cleanup: CleanupFn<T>): () => void {
        return pushCB(this._chain(), cleanup);
    }

    protected _done: FlowResult<T> = undefined;
    protected _cbs = chain<CleanupFn<T>>();
    protected _chain() {
        if (this._done && isEmpty(this._cbs)) defer(this.end);
        return this._cbs;
    }
}

/**
 * Add a cleanup function to the active flow. Non-function values are ignored.
 *
 * @category Flows
 */
export function must<T>(cleanup?: OptionalCleanup<T>): Flow<T> {
    return (getFlow() as Flow<T>).must(cleanup);
}

/**
 * Start a nested flow within the currently-active flow.  (Shorthand for
 * {@link getFlow}().{@link Flow.start start}(...).)
 *
 * This function can be called with zero, one, or two arguments:
 *
 * - When called with zero arguments, the new flow is returned without any other
 *   initialization.
 *
 * - When called with one argument that's a {@link Yielding} iterator (such as a
 *   generator or an existing flow): it's attached to the new flow and executed
 *   asynchronously. (Starting in the next available microtask.)
 *
 * - When called with one argument that's a function (either a {@link SyncStart}
 *   or {@link AsyncStart}): the function is run inside the new flow and
 *   receives it as an argument.  It can return a {@link Yielding} iterator
 *   (such as a generator), a cleanup callback ({@link CleanupFn}), or void.  A
 *   returned Yielding will be treated as if the method was called with that to
 *   begin with; a cleanup callback will be added to the flow as a `must()`.
 *
 * - When called with two arguments -- a "this" object and a function -- it
 *   works the same as one argument that's a function, except the function is
 *   bound to the supplied "this" before being called.
 *
 *   This last signature is needed because you can't make generator arrows in JS
 *   yet: if you want to start() a generator function bound to the current
 *   `this`, you'll want to use `.start(this, function*() { ...whatever  })`.
 *
 *   (Note, however, that TypeScript and/or VSCode may require that you give
 *   such a function an explicit `this` parameter (e.g. `.start(this, function
 *   *(this) {...}));`) in order to correctly infer types inside a generator
 *   function.)
 *
 * In any of the above cases, if a supplied function throws an error, the new
 * flow will be ended, and the error re-thrown.
 *
 * @returns the created {@link Flow}
 *
 * @category Flows
 */
export function start<T>(fn?: Start<T>|Yielding<T>): Flow<T>;

/**
 * The two-argument variant of start() allows you to pass a "this" object that
 * will be bound to the initialization function.  (It's mostly useful for
 * generator functions, since generator arrows aren't a thing yet.)
 */
export function start<T,C>(ctx: C, fn: Start<T,C>): Flow<T>;
export function start<T,C>(fnOrCtx: Start<T>|Yielding<T>|C, fn?: Start<T,C>) {
    return getFlow().start(fnOrCtx, fn);
}

/**
 * Is there a currently active flow? (i.e., can you safely use {@link must}(),
 * {@link release}() or {@link getFlow}() right now?)
 *
 * @category Flows
 */
export function isFlowActive() { return !!current.flow; }

/**
 * Like {@link must}(), except a function is returned that will *remove*
 * the cleanup function from the flow, if it's still present. (Also, the cleanup
 * function isn't optional.)
 *
 * @category Flows
 */
export function release(cleanup: CleanupFn): DisposeFn {
    return getFlow().release(cleanup);
}


/**
 * Return a new {@link Flow}.  If *either* a parent parameter or stop function
 * are given, the new flow is linked to the parent.
 *
 * @param parent The parent flow to which the new flow should be attached.
 * Defaults to the currently-active flow if none given (assuming a stop
 * parameter is provided).
 *
 * @param stop The function to call to destroy the nested flow.  Defaults to the
 * {@link Flow.end} method of the new flow if none is given (assuming a parent
 * parameter is provided).
 *
 * @returns A new flow.  The flow is linked/nested if any arguments are given,
 * or a detached (parentless) flow otherwise.
 *
 * @category Flows
 */
export const makeFlow: <T,R=unknown>(parent?: Flow<R>, stop?: CleanupFn<R>) => Flow<T> = _Flow.create;

/**
 * A special {@link Flow} with no parents, that can be used to create standalone
 * flows.  detached.start() returns a new detached flow, detached.run() can be used
 * to run code that expects to create a child flow, and detached.bind() can wrap
 * a function to work without a parent flow.
 *
 * (Note that in all cases, a child flow of `detached` must be stopped explicitly, or
 * it may "run" forever, never running its cleanup callbacks.)
 *
 * @category Flows
 */
export const detached = (() => {
    const detached = makeFlow();
    detached.end();
    detached.must = () => { throw new Error("Can't add cleanups to the detached flow"); }
    detached.release = () => noop;
    return detached;
})();

/**
 * Wrap a function in a {@link Flow} that restarts each time the resulting
 * function is called, thereby canceling any nested flows and cleaning up any
 * resources used by previous calls. (This can be useful for such things as
 * canceling an in-progress search when the user types more text in a field.)
 *
 * The restarting flow will be ended when the flow that invoked `restarting()`
 * is finished, canceled, or restarted.  Calling the wrapped function after its
 * flow has ended will result in an error.  You can wrap any function any number
 * of times: each call to `restarting()` creates a new, distinct "restarting
 * flow" and function wrapper to go with it.
 *
 * @param task (Optional) The function to be wrapped. This can be any function:
 * the returned wrapper function will match its call signature exactly, including
 * overloads.  (So for example you could wrap the {@link start} API via
 * `restarting(start)`, to create a function you can pass flow-start functions to.
 * When called, the function would cancel any outstanding job from a previous
 * call, and start the new one in its place.)
 *
 * @returns A function of identical type to the input function.  If no input
 * function was given, the returned function will just take one argument (a
 * zero-argument function optionally returning a {@link CleanupFn}).
 *
 * @category Flows
 */
export function restarting(): (task: () => OptionalCleanup<never>) => void
export function restarting<F extends AnyFunction>(task: F): F
export function restarting<F extends AnyFunction>(task?: F): F {
    const outer = getFlow(), inner = makeFlow<never>(), {end} = inner;
    task ||= <F>((f: () => OptionalCleanup<never>) => { inner.must(f()); });
    return <F>function() {
        inner.restart().must(outer.release(end));
        const old = swapCtx(makeCtx(inner));
        try { return task.apply(this, arguments as any); }
        catch(e) { inner.throw(e); throw e; }
        finally { freeCtx(swapCtx(old)); }
    };
}


function runGen<R>(g: Yielding<R>, req?: Request<R>) {
    let it = g[Symbol.iterator](), running = true, ctx = makeCtx(getFlow()), ct = 0;
    let done = release(() => {
        req = undefined;
        ++ct; // disable any outstanding request(s)
        // XXX this should be deferred to cleanup phase, or must() instead of release
        // (release only makes sense here if you can run more than one generator in a job)
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
