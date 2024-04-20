import { ExtType, MaybeHas, extension } from "./ext.ts";
import { pulls } from "./scheduling.ts";
import { CleanupFn, type Job, getJob, start } from "./tracking.ts";
import { isError } from "./results.ts";

type ThrottleExt = ExtType<"uneventful/throttle", _Throttle>;
type MaybeThrottled = MaybeHas<ThrottleExt>;
const {get: throttle, set: setThrottle} = extension<ThrottleExt>("uneventful/throttle");

/**
 * @category Stream Consumers
 */
export function pause(s: Connector | undefined) {
    throttle(s)?.pause();
}

/**
 * Un-pause, and iterate backpressure-able sources' onReady callbacks to
 * resume sending immediately.
 *
 * @category Stream Consumers
 */
export function resume(s: Connector | undefined) {
    throttle(s)?.resume();
}

/**
 * A backpressure controller: returns true if downstream is ready to accept
 * data.
 *
 * @param cb (optional) - a callback to run when the downstream consumer wishes
 * to resume event production (i.e., when a sink calls {@link resume}()).  The
 * callback is automatically unregistered when invoked, so the producer must
 * re-register it after each call if it wishes to keep being called.
 *
 * @category Types and Interfaces
 */
export type Backpressure = (cb?: Producer) => boolean


/**
 * Create a backpressure control function for the given connection
 *
 * @category Stream Producers
 */
export function backpressure(conn: Connector): Backpressure {
    const job = getJob(), t = throttle(conn);
    return (cb?: Producer) => {
        if (!job.result() && t.isOpen()) {
            if (cb) t.onReady(cb, job);
            return t.isReady();
        }
        return false;
    }
}

/**
 * @category Types and Interfaces
 */
export interface Throttle {
    pause(): void;
    resume(): void;
}


/**
 * @category Stream Producers
 */
export type Connection = Job<void>;

/**
 * @category Stream Consumers
 */
export type Connector = Job<void> & MaybeThrottled;

/**
 * A `Source` is a function that can be called to arrange for data to be
 * produced and sent to a {@link Sink} function for consumption, until the
 * associated {@link Connection} is closed (either by the source or the sink,
 * e.g. if the sink doesn't want more data or the source has no more to send).
 *
 * The function must return the special {@link IsStream} value, so TypeScript
 * can tell what functions are actually sources.  (As otherwise any void
 * function with no arguments would appear to be usable as a source!)
 *
 * @category Types and Interfaces
 */
export type Source<T> = (sink: Sink<T>, conn?: Connection) => typeof IsStream;

/**
 * A specially-typed string used to verify that a function supports uneventful's
 * streaming protocol.  Return it from a function that implements the
 * {@link Source} type.
 *
 * @category Types and Interfaces
 */
export const IsStream = "uneventful/is-stream" as const;

/**
 * A `Sink` is a function that receives data from a {@link Source}.
 *
 * @category Types and Interfaces
 */
export type Sink<T> = (val: T) => void;

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
 * Subscribe a sink to a source, returning a nested job.
 *
 * @category Stream Consumers
 */
export function connect<T>(src?: Source<T>, sink?: Sink<T>, to?: Connection): Connector {
    return <Connector> start((job) => {
        setThrottle(job as Connector, (throttle(to as Connector) || new _Throttle(job)));
        if (src && sink) src(sink, job);
    });
}

/**
 * @category Stream Producers
 */
export function subconnect<T>(parent: Connection, src: Source<T>, sink: Sink<T>, to?: Connection): Connector {
    return parent.run(() => {
        const job = getJob();
        if (job.result()) throw new Error("Can't fork or link a closed conduit");
        return connect(src, sink, to).must(res => { if (isError(res)) job.throw(res.err); });
    })
}

class _Throttle {
    /** @internal */
    protected _callbacks: Map<Producer, CleanupFn> = undefined;

    /** @internal */
    constructor(protected _job: Job<void>) {}

    isOpen(): boolean { return !this._job.result(); }

    /** Is the conduit currently ready to receive data? */
    isReady(): boolean { return this.isOpen() && this._isReady; }

    _isReady = true;
    _isPulling = false;

    onReady(cb: Producer, job: Job) {
        if (!this.isOpen()) return this;
        const _callbacks = (this._callbacks ||= new Map);
        const unlink = job.release(() => _callbacks.delete(cb));
        if (this.isReady() && this && !_callbacks.size) {
            pulls.add(this);
        }
        _callbacks.set(cb, unlink);
        return this;
    }

    pause() { this._isReady = false; return this; }

    doPull() {
        if (this._isPulling) return;
        const {_callbacks} = this;
        if (!_callbacks?.size) return;
        this._isPulling = true;
        try {
            for(let [cb, unlink] of _callbacks) {
                if (!this.isReady()) break;  // we're done
                unlink()
                _callbacks.delete(cb);
                cb() // XXX error handling?
            }
        } finally {
            this._isPulling = false;
        }
    }

    resume() {
        if (this.isOpen()) {
            this._isReady = true;
            this.doPull();
        }
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
