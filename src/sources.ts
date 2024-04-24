import { defer } from "./defer.ts";
import { RuleScheduler, cached } from "./signals.ts";
import { type Source, IsStream, Connection, backpressure, connect, Sink, Connector, pause, resume, Backpressure } from "./streams.ts";
import { must, getJob, detached } from "./tracking.ts";
import { DisposeFn } from "./types.ts";
import { isError, isValue, noop } from "./results.ts";

/**
 * A function that emits events, with a .source they're emitted from
 *
 * @category Types and Interfaces
 */
export interface Emitter<T> {
    /** Call the emitter to emit events on its .source */
    (val: T): void;
    /** An event source that receives the events */
    source: Source<T>;
    /** Close all current subscribers' connections */
    end: () => void;
    /** Close all current subscribers' connections with an error */
    throw: (e: any) => void;
};

/**
 * Create an event source and a function to emit events on it
 *
 * (Note: you must specify the event type (e.g. `emitter<number>()`), since
 * there's nothing else to infer it from.)
 *
 * @returns A function that emits events, with a .source property they're
 * emitted on.
 *
 * @category Stream Producers
 */
export function emitter<T>(): Emitter<T> {
    const emit = mockSource<T>();
    emit.source = share(emit.source);
    return emit;
}

/**
 * A stream that immediately closes
 *
 * @category Stream Producers
 */
export function empty(): Source<never> {
    return (_, conn) => (conn?.return(), IsStream);
}

/**
 * Convert an async iterable to an event source
 *
 * Each time the resulting source is subscribed to, it will emit an event for
 * each item output by the iterator, then end the stream.  Pause/resume is
 * supported.
 *
 * @category Stream Producers
 */
export function fromAsyncIterable<T>(iterable: AsyncIterable<T>): Source<T> {
    return (sink, conn=connect()) => {
        const ready = backpressure(conn);
        const iter = iterable[Symbol.asyncIterator]();
        if (iter.return) must(() => iter.return());
        return ready(next), IsStream;
        function next() {
            iter.next().then(({value, done}) => {
                if (done) conn.return(); else ready(() => {
                    if (sink(value), ready()) next(); else ready(next);
                })
            }, e => conn.throw(e));
        }
    }
}

/**
 * Create an event source from an element, window, or other event target
 *
 * You can manually override the expected event type using a type parameter,
 * e.g. `fromDomEvent<CustomEvent>(someTarget, "custom-event")`.
 *
 * @param target an HTMLElement, Window, Document, or other EventTarget.
 * @param type the name of the event to add a listener for
 * @param options a boolean capture option, or an object of event listener
 * options
 * @returns a source that can be subscribed or piped, issuing events from the
 * target of the specified type.
 *
 * @category Stream Producers
 */
export function fromDomEvent<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
    target: T, type: K, options?: boolean | AddEventListenerOptions
): Source<HTMLElementEventMap[K]>;
export function fromDomEvent<T extends Window, K extends keyof WindowEventMap>(
    target: T, type: K, options?: boolean | AddEventListenerOptions
): Source<WindowEventMap[K]>;
export function fromDomEvent<T extends Document, K extends keyof DocumentEventMap>(
    target: T, type: K, options?: boolean | AddEventListenerOptions
): Source<DocumentEventMap[K]>;
export function fromDomEvent<T extends Event>(
    target: EventTarget, type: string, options?: boolean | AddEventListenerOptions
): Source<T>
export function fromDomEvent<T extends EventTarget, K extends string>(
    target: T, type: K, options?: boolean | AddEventListenerOptions
): Source<Event> {
    return (sink) => {
        function push(v: Event) { sink(v); }
        target.addEventListener(type, push, options);
        must(() => target.removeEventListener(type, push, options));
        return IsStream;
    }
}

/**
 * Convert an iterable to a synchronous event source
 *
 * Each time the resulting source is subscribed to, it will emit an event for
 * each item in the iterator, then close the conduit.  Pause/resume is
 * supported.
 *
 * @category Stream Producers
 */
export function fromIterable<T>(iterable: Iterable<T>): Source<T> {
    return (sink, conn=connect()) => {
        const ready = backpressure(conn);
        const iter = iterable[Symbol.iterator]();
        if (iter.return) must(() => iter.return());
        return ready(loop), IsStream;
        function loop() {
            try {
                for(;;) {
                    const {value, done} = iter.next();
                    if (done) return conn.return();
                    if (sink(value), !ready()) return ready(loop);
                }
            } catch (e) {
                conn.throw(e);
            }
        }
    }
}

/**
 * Convert a Promise to an event source
 *
 * Each time the resulting source is subscribed to, it will emit an event for
 * the result of the promise, then close the conduit.  (Unless the promise is
 * rejected, in which case the conduit throws and closes each time the source is
 * subscribed.)  Non-native promises and non-promise values are converted using
 * Promise.resolve().
 *
 * @category Stream Producers
 */
export function fromPromise<T>(promise: Promise<T>|PromiseLike<T>|T): Source<T> {
    return (sink, conn) => {
        const job = getJob();
        Promise.resolve(promise).then(
            v => void (job.result() || (sink(v), conn?.return())),
            e => void (job.result() || conn?.throw(e))
        )
        return IsStream;
    }
}

/**
 * Create an event source from a signal (or signal-using function)
 *
 * The resulting event source will emit an event equal to each value the given
 * function produces, including its current value at the time of subscription.
 * (Technically, at the time of its first post-subscription scheduling.)
 *
 * @param scheduler - An {@link RuleScheduler} that will be used to sample the
 * signal.  Events will be only be emitted when the given scheduler is run.  If
 * no scheduler is given, the default (microtask-based) scheduler is used.
 *
 * @category Stream Producers
 */
export function fromSignal<T>(s: () => T, scheduler = RuleScheduler.for(defer)): Source<T> {
    s = cached(s);
    return (sink) => {
        scheduler.rule(() => { sink(s()); });
        return IsStream;
    }
}

/**
 * Create an event source from an arbitrary subscribe/unsubscribe function
 *
 * The supplied "subscribe" function will be passed a 1-argument callback and
 * must return an unsubscribe function.  The callback should be called with
 * events of the appropriate type, and the unsubscribe function will be called
 * when the connection is closed.
 *
 * (Note: it's okay if the act of subscribing causes an immediate callback, as
 * the subscribe function will be called in a separate microtask.)
 *
 * @category Stream Producers
 */
export function fromSubscribe<T>(subscribe: (cb: (val: T) => void) => DisposeFn): Source<T> {
    return (sink) => {
        const f = getJob().must(() => sink = noop);
        return defer(() => f.must(subscribe(v => { sink(v); }))), IsStream;
    }
}

/**
 * Create a source that emits a single given value
 *
 * @category Stream Producers
 */
export function fromValue<T>(val: T): Source<T> {
    return (sink, conn) => {
        must(() => { sink = noop; conn = undefined; })
        return defer(() => { sink(val); conn?.return(); }), IsStream;
    }
}

/**
 * Create an event source that issues a number every `ms` milliseconds (starting
 * with 0 after the first interval passes).
 *
 * @category Stream Producers
 */
export function interval(ms: number): Source<number> {
    return (sink) => {
        let idx = 0, id = setInterval(() => sink(idx++), ms);
        return must(() => clearInterval(id)), IsStream;
    }
}

/**
 * Create a dynamic source that is created each time it's subscribed
 *
 * @param factory A function returning a source of the desired type.  It will be
 * called whenever the lazy() stream is subscribed, and its result subscribed to.
 *
 * @returns A stream of the same type as the factory function returns
 *
 * @category Stream Producers
 */
export function lazy<T>(factory: () => Source<T>): Source<T> {
    return (sink, conn) => factory()(sink, conn)
}

/**
 * An {@link Emitter} with a ready() method, that only supports a single active
 * subscriber.  (Useful for testing stream operators and sinks.)
 *
 * @category Types and Interfaces
 */
export interface MockSource<T> extends Emitter<T> {
    ready: Backpressure
}

/**
 * Like {@link emitter}, but with a ready() backpressure method.  It also only
 * supports a single active subscriber.  (Useful for testing stream operators
 * and sinks.)
 *
 * @category Stream Producers
 */
export function mockSource<T>(): MockSource<T> {
    let write: Sink<T>, outlet: Connection, ready: Backpressure;
    function emit(val: T) { if (write) write(val); };
    emit.source = (mockSource ? (x: Source<T>) => x : share<T>)((sink, conn) => {
        write = sink; outlet = conn; ready = backpressure(conn);
        must(() => write = outlet = ready = undefined);
        return IsStream;
    });
    emit.end = () => outlet?.return();
    emit.throw = (e: any) => outlet?.throw(e);
    emit.ready = (cb?: () => any) => ready(cb);
    return emit;
}

/**
 * A stream that never emits or closes
 *
 * @category Stream Producers
 */
export function never(): Source<never> {
    return () => IsStream;
}

/**
 * Wrap a source to allow multiple subscribers to the same underlying stream
 *
 * The input source will be susbcribed when the output has at least one
 * subscriber, and unsubscribed when the output has no subscribers.  The input
 * will only be paused when all subscribers pause (i.e. all sinks return false),
 * and will be resumed when any subscriber resume()s.  All subscribers are closed
 * or thrown if the input source closes or throws.
 *
 * (Generally speaking, you should place the share call as late in your pipelines
 * as possible, if you use it at all.  It adds some overhead that is wasted if
 * the stream doesn't have multiple subscribers, and may be redundant if an
 * upstream source is already shared.  It's mainly useful if there is a lot of
 * mapping, filtering, or other complicated processing taking place upstream of
 * the share, and you know for a fact there will be enough subscribers to make
 * it a bottleneck.)
 *
 * @category Stream Operators
 */
export function share<T>(source: Source<T>): Source<T> {
    let uplink: Connector, resumed = false;
    let links = new Set<[sink: Sink<T>, conn: Connection, bp: Backpressure]>;
    return (sink, conn=connect()) => {
        const ready = backpressure(conn);
        const self: [Sink<T>, Connection, Backpressure] = [sink, conn, ready];
        links.add(self);
        ready(produce);
        must(() => {
            links.delete(self);
            if (!links.size) uplink?.end();
        });
        if (links.size === 1) {
            uplink = detached.bind(connect)(source, v => {
                resumed = false;
                for(const [s,_,ready] of links) {
                    if (s(v), ready()) resumed = true; else ready(produce);
                }
                resumed || pause(uplink);
            }).do(r => {
                uplink = undefined;
                links.forEach(([_,c]) => isError(r) ? c.throw(r.err) : (
                    isValue(r) ? c.return() : c.end()
                ));
            })
        }
        function produce() {
            if (!resumed) {
                resumed = true;
                resume(uplink);
            };
        }
        return IsStream;
    }
}
