import { pulls } from "./internals.ts";
import { DisposeFn, Job } from "./types.ts";
import { getJob } from "./tracking.ts";
import { current } from "./ambient.ts";

/**
 * A backpressure controller: returns true if downstream is ready to accept
 * data.
 *
 * @param cb (optional) - a callback to run when the downstream consumer wishes
 * to resume event production (i.e., when a sink calls
 * {@link Throttle.resume}()).  The callback is automatically unregistered when
 * invoked, so the producer must re-register it after each call if it wishes to
 * keep being called.
 *
 * @category Types and Interfaces
 */
export type Backpressure = (cb?: () => any) => boolean


/**
 * Create a backpressure control function for the given connection
 *
 * @category Stream Producers
 */
export function backpressure(inlet: Inlet = defaultInlet): Backpressure {
    const job = getJob();
    return (cb?: Flush) => {
        if (!job.result() && inlet.isOpen()) {
            if (cb) inlet.onReady(cb, job);
            return inlet.isReady();
        }
        return false;
    }
}

/**
 * Control backpressure for listening streams.  This interface is the API
 * internal to the implementation of {@link backpressure}().  Unless you're
 * implementing a backpressurable stream yourself, see the {@link Throttle}
 * interface instead.
 *
 * @category Types and Interfaces
 */
export interface Inlet {
    /** Is the main connection open?  (i.e. is the creating job not closed yet?) */
    isOpen(): boolean

    /** Is the connection ready to receive data? */
    isReady(): boolean

    /**
     * Register a callback to produce more data when the inlet is resumed
     * (The callback is unregistered if the supplied job ends.)
     */
    onReady(cb: () => any, job: Job): this;
}

/**
 * Control backpressure for listening streams
 *
 * Obtain instances via {@link throttle}(), then pass them into the appropriate
 * stream-consuming API.  (e.g. {@link connect}).
 *
 * @category Types and Interfaces
 */
export interface Throttle extends Inlet {
    /** Set inlet status to "paused". */
    pause(): void;

    /**
     * Un-pause, and iterate backpressure-able sources' onReady callbacks to
     * resume sending immediately.  (i.e., synchronously!)
     */
    resume(): void;
}

/**
 * A Connection is a job that returns void when the connected stream ends
 * itself.  If the stream doesn't end itself (e.g. it's an event listener), the
 * job will never return, and only end with a cancel or throw.
 *
 * @category Types and Interfaces
 */
export type Connection = Job<void>;

/**
 * A Source is a function that can be called to arrange for data to be
 * produced and sent to a {@link Sink} function for consumption, until the
 * associated {@link Connection} is closed (either by the source or the sink,
 * e.g. if the sink doesn't want more data or the source has no more to send).
 *
 * If the source is a backpressurable stream, it can use the (optional) supplied
 * inlet (usually a {@link throttle}()) to rate-limit its output.
 *
 * A producer function *must* return the special {@link IsStream} value, so
 * TypeScript can tell what functions are usable as sources.  (Otherwise any
 * void function with no arguments would appear to be usable as a source!)
 *
 * @category Types and Interfaces
 */
export interface Source<T> {
    /** Subscribe sink to receive values */
    (sink: Sink<T>, conn?: Connection, inlet?: Throttle | Inlet): typeof IsStream;
}

/**
 * An uneventful stream is either a {@link Source} or a {@link SignalSource}.
 * (Signals actually implement the {@link Source} interface as an overload, but
 * TypeScript gets confused about that sometimes, so we generally declare our
 * stream *inputs* as `Stream<T>` and our stream *outputs* as {@link Source}, so
 * that TypeScript knows what's what.
 *
 * @category Types and Interfaces
 */
export type Stream<T> = Source<T> | SignalSource<T>;

/**
 * The call signatures implemented by signals.  (They can be used as sources, or
 * called with no arguments to return a value.)
 *
 * This type is needed because TypeScript won't infer the overloads of
 * {@link Signal} correctly otherwise. (Specifically, it won't allow it to be
 * used as a zero-agument function.)
 *
 * @category Types and Interfaces
*/
export type SignalSource<T> = Source<T> & {
    /** A signal object can be called to get its current value */
    (): T
}

/**
 * A specially-typed string used to verify that a function supports uneventful's
 * streaming protocol.  Return it from a function to implement the
 * {@link Source} type.
 *
 * @category Types and Interfaces
 */
export const IsStream = "uneventful/is-stream" as const;

/**
 * A `Sink` is a function that receives data from a {@link Stream}.
 *
 * @category Types and Interfaces
 */
export type Sink<T> = (val: T) => void;

/**
 * A `Transformer` is a function that takes one stream and returns another,
 * possibly one that produces data of a different type.  Most operator functions
 * return a transformer, allowing them to be combined via {@link pipe}().
 *
 * @category Types and Interfaces
 */
export type Transformer<T, V=T> = (input: Stream<T>) => Source<V>;

type Flush = () => any


/**
 * Subscribe a sink to a stream, returning a nested job. (Shorthand for
 * .{@link Job.connect connect}(...) on the active job.)
 *
 * @param src An event source or signal
 * @param sink A callback that will receive the events
 * @param inlet Optional - a {@link throttle}() to control backpressure
 *
 * @returns A job that can be aborted to end the subscription, and which will
 * end naturally (with a void return or error) if the stream ends itself.
 *
 * @category Stream Consumers
 */
export function connect<T>(src: Stream<T>, sink: Sink<T>, inlet?: Throttle | Inlet): Connection {
    return getJob().connect(src, sink, inlet);
}

/**
 * Create a backpressure controller for a stream.  Pass it to one or more
 * sources you're connecting to, and if they support backpressure they'll
 * respond when you call its .pause() and .resume() methods.
 *
 * @param job - Optional: a job that controls readiness.  (The throttle will
 * pause indefinitely when the job ends.)  Defaults to the currently-active job,
 * but unlike most such defaults, it won't throw if no job is active.
 *
 * @category Stream Consumers
 */
export function throttle(job: Job = current.job): Throttle {
    return new _Throttle(job);
}

class _Throttle implements Throttle {
    /** @internal */
    protected _callbacks: Map<Flush, DisposeFn> = undefined;

    /** @internal */
    constructor(protected _job?: Job) {}

    isOpen(): boolean { return !this._job?.result(); }

    /** Is the connection ready to receive data? */
    isReady(): boolean { return this.isOpen() && this._isReady; }

    _isReady = true;
    _isPulling = false;

    onReady(cb: Flush, job: Job) {
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

const defaultInlet: Inlet = throttle();

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

/**
 * Pass subscriber into a stream (or any arguments into any other function).
 *
 * This utility is mainly here for uses like:
 *
 * - `pipe(src, into(sink))`,
 * - `pipe(src, into(sink, conn))`,
 * - `pipe(src, into(restarting(sink)))`, etc.
 *
 * but can also be used for argument currying generally.
 *
 * @param args The arguments to pass to the stream (or other function)
 *
 * @returns a function that takes another function and calls it with the given args.
 *
 * @category Stream Consumers
 */
export function into<In extends any[], Out>(...args: In): (src: (...args: In) => Out) => Out {
    return src => src(...args);
}
