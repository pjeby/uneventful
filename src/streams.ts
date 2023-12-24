import { defer } from "./defer.ts";
import { pulls } from "./scheduling.ts";
import { CleanupFn, OptionalCleanup, type Flow, makeFlow } from "./tracking.ts";

/**
 * A `Source` is a function that can be called to arrange for data to be
 * produced and sent to a {@link Sink} function for consumption, until the
 * associated {@link Conduit} is closed (either by the source or the sink, e.g.
 * if the sink doesn't want more data or the source has no more to send).
 *
 * The function must return the conduit. (Mostly so TypeScript can tell what
 * functions are actually sources, as otherwise any void function with no
 * arguments would appear to be usable as a source.)  The source function is
 * invoked with the conduit's flow active, so it can freely use flows or
 * resources that need {@link onCleanup} and the like.
 *
 * @category Types and Interfaces
 */
export type Source<T> = (conn: Conduit, sink: Sink<T>) => Conduit;

/**
 * A `Sink` is a function that receives data from a {@link Source}. In addition
 * to the data, the {@link Conduit} that controls the sending is passed, so the
 * consumer can close it.
 *
 * A sink must return `true` if it can immediately (i.e. synchronously) be
 * called with the next value.  It should return `false` instead if a
 * synchronous source should wait before producing more values (and then call
 * the conduit's {@link Conduit.resume .resume()} method when it's ready to receive
 * the next value).
 *
 * (Note: the return value only affects *synchronous* sources, as async sources
 * can call the sink at any time, as long as the conduit is still open.)
 *
 * @category Types and Interfaces
 */
export type Sink<T> = (val: T, conn: Conduit) => boolean;

/**
 * A `Transformer` is a function that takes one source and returns another,
 * possibly one that produces data of a different type.  Most operator functions
 * return a transformer, allowing them to be combined via {@link pipe `pipe()`}.
 *
 * @category Types and Interfaces
 */
export type Transformer<T, V=T> = (input: Source<T>) => Source<V>;

type Producer = () => any


/**
 * Subscribe a sink to a source, returning a conduit linked to the active flow.
 *
 * Note: some sources may not begin sending events until after
 * {@link Conduit.resume .resume()} is called on the returned conduit.
 *
 * @category Stream Consumers
 */
export function connect<T>(src: Source<T>, sink: Sink<T>) {
    return new Conduit(null, null, src, sink);
}

/** Conduit state flags */
const enum Is {
    Unset = 0,
    _ = 1,
    Open    = _ << 0,
    Error   = _ << 1,
    Caught  = _ << 2,
    Ready   = _ << 3,
    Pulling = _ << 4,
}
function is(flags: Is, mask: Is, eq = mask) {
    return (flags & mask) === eq;
}

/**
 * The connection between an event {@link Source} and its {@link Sink}
 * (subscriber).
 *
 * Conduits simplify coding of stream transformers and event sources by managing
 * resource cleanup (via {@link onCleanup}() callbacks) and connection state.
 * Sources can {@link push}() data to a sink as long as the conduit is open, and
 * sinks can {@link resume}() to say, "I'm ready for more data".  (Which sources
 * can subscribe to via {@link onReady}().)
 *
 * Sources can also create child conduits (via a conduit's {@link link}() and
 * {@link fork}() methods), making it easier to implement operators like
 * `reduce()` or `takeUntil()`, and have the other connections disposed of when
 * the main one is, or automatically propagate errors from a child conduit to
 * its parent.
 *
 * @category Types and Interfaces
 */
export class Conduit {
    /** @internal */
    protected _flags = Is.Open | Is.Ready;
    /** @internal */
    protected _flow: Flow;
    /** @internal */
    protected _callbacks: Map<Producer, CleanupFn>;
    /** @internal */
    protected _root: Conduit;

    /** The reason passed to throw(), if any */
    reason: any;

    /** @internal */
    constructor(parent?: Flow, root?: Conduit, src?: Source<any>, sink?: Sink<any>) {
        this._root = root ?? this;
        this._flow = makeFlow(parent, this.close);
        if (src && sink) this._flow.run(src, this, sink);
    }

    /** Is the conduit currently open? */
    isOpen(): boolean { return is(this._flags, Is.Open); }

    /** Is the conduit currently ready to receive data? */
    isReady(): boolean { return is(this._root._flags, Is.Ready); }

    /** Has the comment been closed with an error? */
    hasError(): boolean { return is(this._flags, Is.Error); }

    /**
     * Has the conduit been closed with an error without a corresponding
     * {@link catch}()?
     *
     * Note: this always returns false if a catch() function has been
     * registered, even if the catch() function hasn't been run yet.
     */
    hasUncaught(): boolean {
        return is(this._flags, (Is.Error|Is.Caught), Is.Error);
    }

    /**
     * Register a cleanup function to run when the conduit closes or throws.
     *
     * If the conduit is already closed, the function will run in the next
     * microtask.  Otherwise, cleanup callbacks run in reverse order as with
     * any other flow.
     */
    onCleanup(fn?: OptionalCleanup) {
        this.isOpen() ? this._flow.onCleanup(fn) : fn && defer(fn);
        return this;
    }

    /**
     * Register a callback to run when an async consumer wishes to resume event
     * production (i.e., when a sink calls {@link resume}()).  The callback is
     * automatically unregistered when invoked, so the producer must re-register
     * it after each call if it wishes to keep being called.
     */
    onReady(cb: Producer) {
        if (!this.isOpen()) return this;
        const {_root} = this, _callbacks = (_root._callbacks ||= new Map);
        const unlink = this._flow.linkedCleanup(() => _callbacks.delete(cb));
        if (_root.isReady() && is(_root._flags, Is.Pulling, Is.Unset) && !_callbacks.size) {
            pulls.add(_root);
        }
        _callbacks.set(cb, unlink);
        return this;
    }

    /**
     * Return a bound version of .{@link push}() for a specific sink
     *
     * @returns a 1-argument function that sends its argument to the sink,
     * returning the sink's return value, or false if the conduit is closed or
     * thrown.  If the sink throws, the error is thrown to the conduit as well.
     */
    writer<T>(sink: Sink<T>): (val: T) => boolean {
        return this.push.bind<this, [Sink<T>], [T], boolean>(this, sink);
    }

    /**
     * Send data to a sink, returning the result.  (Or false if the conduit is closed.)
     *
     * If the sink throws an error, the conduit closes with that error, and push() returns false.
     * If the sink returns false, the conduit's root is marked paused.
     */
    push<T>(sink: Sink<T>, val: T): boolean {
        try {
            return this.isOpen() && (sink(val, this) || (this._root.pause(), false));
        } catch(e) {
            this.throw(e);
            return false;
        }
    }

    pause() { this._flags &= ~Is.Ready; return this; } // XXX throw if not this?

    doPull() {
        if (is(this._flags, Is.Pulling)) return;
        const {_callbacks} = this;
        if (!_callbacks?.size) return;
        this._flags |= Is.Pulling;
        try {
            for(let [cb, unlink] of _callbacks) {
                unlink()
                if (!this.isReady()) break;  // we're done
                _callbacks.delete(cb);
                cb() // XXX error handling?
            }
        } finally {
            this._flags &= ~Is.Pulling;
        }
    }

    /**
     * Un-pause, and iterate backpressure-able sources' onReady callbacks to
     * resume sending immediately.
     */
    resume() {
        if (is(this._root._flags, (Is.Ready|Is.Open), Is.Open)) {
            this._root._flags |= Is.Ready;
        }
        if (this.isOpen()) this._root.doPull();
    }

    /**
     * Close the conduit, cleaning up resources and terminating child conduits.
     */
    close = () => {
        if (this._flags & Is.Open) {
            this._flags &= ~(Is.Open|Is.Ready);
            this._flow.cleanup();
            this._flow = undefined;
        }
        return this;
    }

    /**
     * Close the conduit with an error, cleaning up resources and terminating
     * child conduits. If the conduit was created via {@link link}(), the error
     * will be passed along to the parent conduit (if it's not already closed or
     * thrown).
     *
     * The reason passed to throw() will be readable via the conduit's
     * {@link Conduit.reason .reason} property.
     */
    throw(reason: any) {
        if (this._flags & Is.Open) {
            this._flags |= Is.Error;
            this.reason = reason;
            this.close();
        }
        return this;
    }

    /**
     * Add an asynchronous error handler that responds to throw()
     *
     * The handler will be called asynchronously if the conduit already has an
     * error.
     */
    catch(handler?: (reason: any, conn: this) => unknown): this {
        this._flags |= Is.Caught;
        if (handler) return this.onCleanup(() => { if (this.hasError()) handler(this.reason, this); });
        return this;
    }

    /**
     * Create a child conduit, optionally setting up a source subscription.
     *
     * If a source and sink are supplied, the source is called with the sink and
     * the new conduit.
     *
     * The returned conduit will close when the parent conduit closes or throws.
     * (Errors in the child will *not* propagate to the parent and so must be
     * explicitly handled.  If you want automatic error propagation, use
     * {@link link}() instead.)
     */
    fork<T>(src?: Source<T>, sink?: Sink<T>, root?: Conduit) {
        if (this.isOpen()) {
            return new Conduit(this._flow, root, src, sink);
        }
        throw new Error("Can't fork or link a closed conduit")
    }

    /**
     * Create a linked conduit, optionally setting up a source subscription.
     *
     * If a source and sink are supplied, the source is called with the sink and
     * the new conduit.
     *
     * The returned conduit will close when the parent conduit closes or throws.
     * Errors in the child will automatically be propagated to the parent, so that
     * it will also throw if the child does.
     */
    link<T>(src?: Source<T>, sink?: Sink<T>, root?: Conduit) {
        const f = this.fork(src, sink, root).onCleanup(() => {
            if (f.hasError()) this.throw(f.reason);
        });
        return f;
    }
}


/**
 * Pipe a stream (or anything else) through a series of single-argument
 * functions/operators
 *
 * e.g. the following creates a stream that outputs 4 and then 6:
 *
 * ```ts
 * pipe(fromIterable([1,2,3,4]), skip(1), take(2), map(x => x*2))
 * ```
 *
 * The first argument to pipe() can be any value, but all other arguments must
 * be functions.  The value is passed to the first function, and then the result
 * is passed to the next function in turn, until all provided functions have
 * been called with the result of the previous function.  The return value is
 * the last result, or the original value if no functions were given.
 *
 * The underlying implementation of pipe() works with any number of arguments,
 * but due to TypeScript limitations we only have typing defined for a max of 9
 * functions (10 arguments total).  If you need more than 9 functions, you can
 * stack some of them with {@link compose}(), e.g.:
 *
 * ```typescript
 * pipe(
 *     aStream,
 *     compose(op1, op2, ...),
 *     compose(op10, op11, ...),
 *     compose(op19, ...),
 *     ...
 * )
 * ```
 *
 * @category Stream Operators
 */
export function pipe<A,B,C,D,E,F,G,H,I,J>(input: A, ...fns: Chain9<A,J,B,C,D,E,F,G,H,I>): J
export function pipe<A,B,C,D,E,F,G,H,I>  (input: A, ...fns: Chain8<A,I,B,C,D,E,F,G,H>):   I
export function pipe<A,B,C,D,E,F,G,H>    (input: A, ...fns: Chain7<A,H,B,C,D,E,F,G>):     H
export function pipe<A,B,C,D,E,F,G>      (input: A, ...fns: Chain6<A,G,B,C,D,E,F>):       G
export function pipe<A,B,C,D,E,F>        (input: A, ...fns: Chain5<A,F,B,C,D,E>):         F
export function pipe<A,B,C,D,E>          (input: A, ...fns: Chain4<A,E,B,C,D>):           E
export function pipe<A,B,C,D>            (input: A, ...fns: Chain3<A,D,B,C>):             D
export function pipe<A,B,C>              (input: A, ...fns: Chain2<A,C,B>):               C
export function pipe<A,B>                (input: A, ...fns: Chain1<A,B>):                 B
export function pipe<A>                  (input: A): A
export function pipe(input: any, ...fns: Array<(v: any) => any>): any;
export function pipe<A,X>(): X {
    var v = arguments[0];
    for (var i=1; i<arguments.length; i++) v = arguments[i](v);
    return v;
}

/**
 * Compose a series of single-argument functions/operators in application order.
 * (This is basically a deferred version of {@link pipe}().)  For example:
 *
 * ```ts
 * const func = compose(skip(1), take(2), map(x => x*2));
 * const stream_4_6 = func(fromIterable([1,2,3,4])); // stream that outputs 4, 6
 * ```
 *
 * As with `pipe()`, the declared typings only support composing up to 9
 * functions at once; if you need more you'll need to nest calls to `compose()`
 * (i.e. passing the result of a `compose()` as an argument to another
 * `compose()` call.)
 *
 * @returns A function taking the same type as the first input function,
 * returning the same type as the last input function.
 *
 * @category Stream Operators
 */
export function compose<A,B,C,D,E,F,G,H,I,J>(...fns: Chain9<A,J,B,C,D,E,F,G,H,I>): (a: A) => J
export function compose<A,B,C,D,E,F,G,H,I>  (...fns: Chain8<A,I,B,C,D,E,F,G,H>):   (a: A) => I
export function compose<A,B,C,D,E,F,G,H>    (...fns: Chain7<A,H,B,C,D,E,F,G>):     (a: A) => H
export function compose<A,B,C,D,E,F,G>      (...fns: Chain6<A,G,B,C,D,E,F>):       (a: A) => G
export function compose<A,B,C,D,E,F>        (...fns: Chain5<A,F,B,C,D,E>):         (a: A) => F
export function compose<A,B,C,D,E>          (...fns: Chain4<A,E,B,C,D>):           (a: A) => E
export function compose<A,B,C,D>            (...fns: Chain3<A,D,B,C>):             (a: A) => D
export function compose<A,B,C>              (...fns: Chain2<A,C,B>):               (a: A) => C
export function compose<A,B>                (...fns: Chain1<A,B>):                 (a: A) => B
export function compose<A>                  (): (a: A) => A
export function compose(...fns: ((v:any)=>any)[]) {
    return (val:any) => (pipe as any)(val, ...fns);
}

type Chain1<A,R>                 = [(v: A) => R];
type Chain2<A,R,B>               = [...Chain1<A,B>, ...Chain1<B,R>];
type Chain3<A,R,B,C>             = [...Chain1<A,B>, ...Chain2<B,R,C>];
type Chain4<A,R,B,C,D>           = [...Chain1<A,B>, ...Chain3<B,R,C,D>];
type Chain5<A,R,B,C,D,E>         = [...Chain1<A,B>, ...Chain4<B,R,C,D,E>];
type Chain6<A,R,B,C,D,E,F>       = [...Chain1<A,B>, ...Chain5<B,R,C,D,E,F>];
type Chain7<A,R,B,C,D,E,F,G>     = [...Chain1<A,B>, ...Chain6<B,R,C,D,E,F,G>];
type Chain8<A,R,B,C,D,E,F,G,H>   = [...Chain1<A,B>, ...Chain7<B,R,C,D,E,F,G,H>];
type Chain9<A,R,B,C,D,E,F,G,H,I> = [...Chain1<A,B>, ...Chain8<B,R,C,D,E,F,G,H,I>];
