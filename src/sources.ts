import { defer } from "./defer.ts";
import { type Stream, IsStream, backpressure, Sink, Connection, Backpressure, throttle, Inlet, Source } from "./streams.ts";
import { getJob, root } from "./tracking.ts";
import { must, start } from "./jobutils.ts";
import { DisposeFn } from "./types.ts";
import { isCancel, isError, isUnhandled, markHandled, noop } from "./results.ts";

/**
 * A function that emits events, with a .source they're emitted from
 *
 * Created using {@link emitter}.
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
    return (sink, conn=start(), inlet) => {
        const ready = backpressure(inlet);
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
 * each item in the iterator, then close the connection.  Pause/resume is
 * supported.
 *
 * @category Stream Producers
 */
export function fromIterable<T>(iterable: Iterable<T>): Source<T> {
    return (sink, conn=start(), inlet) => {
        const ready = backpressure(inlet);
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
 * the result of the promise, then close the connection.  (Unless the promise is
 * rejected, in which case the connection throws and closes each time the source
 * is subscribed.)  Non-native promises and non-promise values are converted
 * using Promise.resolve().
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
export function lazy<T>(factory: () => Stream<T>): Source<T> {
    return (sink, conn, inlet) => factory()(sink, conn, inlet)
}

/**
 * An {@link Emitter} with a ready() method, that only supports a single active
 * subscriber.  (Useful for testing stream operators and sinks.)
 *
 * Created using {@link mockSource}().
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
    const emit: MockSource<T> = (val: T) => { if (write) write(val); };
    emit.source = (sink, conn, inlet) => {
        write = sink; outlet = conn; ready = backpressure(inlet);
        must(() => write = outlet = ready = undefined);
        return IsStream;
    };
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
 * will be paused when any subscriber pauses, and will only be resumed when all
 * subscribers are unpaused.  All subscribers are closed or thrown if the input
 * source closes or throws.
 *
 * (Generally speaking, you should place the share call as late in your
 * pipelines as possible, if you use it at all.  It adds some overhead that is
 * wasted if the stream doesn't have multiple subscribers, and may be redundant
 * if an upstream source is already shared.  It's mainly useful if there is a
 * lot of mapping, filtering, or other complicated processing taking place
 * upstream of the share, and you know for a fact there will be enough
 * subscribers to make it a bottleneck.  You should probably also consider
 * putting some {@link slack}() either upstream or downstream of the share, if
 * the upstream supports backpressure.)
 *
 * @category Stream Operators
 */
export function share<T>(source: Stream<T>): Source<T> {
    let uplink: Connection;
    const
        links = new Set<[sink: Sink<T>, conn: Connection]>,
        inlets = new Map<Inlet, number>(),  // refcounts of incoming inlets
        t = throttle(), // the actual onReady queue
        multi: Inlet = {
            // A multi-connection inlet that requires all downstreams to be ready
            isOpen() { return !uplink?.result(); },
            isReady() {
                if (this.isOpen()) {
                    for (const [i] of inlets) if (!i.isReady()) return (t.pause(), false);
                    return true;
                }
                t.pause();
                return false;
            },
            onReady(cb, job) {
                if (this.isOpen()) {
                    t.onReady(cb, job);
                    for (const [i] of inlets) i.isReady() || i.onReady(produce, job);
                }
                return this;
            }
        }
    ;
    function produce() { multi.isReady() && t.resume(); }

    return (sink, conn=start(), inlet) => {
        const self: [Sink<T>, Connection] = [sink, conn];
        links.add(self);
        if (inlet) inlets.set(inlet, 1+(inlets.get(inlet) || 0));
        conn.must(() => {
            links.delete(self);
            if (inlet) {
                inlets.set(inlet, inlets.get(inlet)-1);
                if (!inlets.get(inlet)) inlets.delete(inlet);
            }
            if (!links.size) uplink?.end();
            else if (multi.isReady() && !t.isReady()) defer(produce);
        });
        if (links.size === 1) {
            uplink = root.connect(source, v => {
                for(const [s, c] of links) try { s(v) } catch(e) { c.throw(e); };
            }, multi).do(r => {
                uplink = undefined;
                if (isCancel(r)) return;
                if (isUnhandled(r)) markHandled(r);
                for(const [_, c] of links) isError(r) ? c.throw(r.err) : c.return();
            })
        }
        return IsStream;
    }
}
