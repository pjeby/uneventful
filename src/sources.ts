import { share } from "./operators.ts";
import { cached, effect } from "./signals.ts";
import { type Source, type Conduit } from "./streams.ts";
import { type DisposeFn } from "./tracking.ts";

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
    close: () => void;
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
    let write: (val: T) => boolean, conduit: Conduit;
    function emit(val: T) { if (write) write(val); };
    emit.source = share<T>((conn, sink) => {
        write = conn.writer(sink);
        conduit = conn;
        return conn.onCleanup(() => write = conduit = undefined);
    });
    emit.close = () => conduit?.close();
    emit.throw = (e: any) => conduit?.throw(e);
    return emit;
}

/**
 * A stream that immediately closes
 *
 * @category Stream Producers
 */
export function empty(): Source<never> {
    return (conn) => conn.close();
}

/**
 * Convert an async iterable to an event source
 *
 * Each time the resulting source is subscribed to, it will emit an event for
 * each item output by the iterator, then close the conduit.  The subscriber
 * must return `true` after each value to continue iteration, or `false` to
 * pause it. (Once paused, it must then call the conduit's
 * {@link Conduit.resume .resume()} method to resume iteration.)
 *
 * @category Stream Producers
 */
export function fromAsyncIterable<T>(iterable: AsyncIterable<T>): Source<T> {
    return (conn, sink) => {
        const send = conn.writer(sink), iter = iterable[Symbol.asyncIterator]();
        if (iter.return) conn.onCleanup(() => iter.return());
        return conn.onReady(next);
        function next() {
            iter.next().then(({value, done}) => {
                if (done) conn.close(); else conn.onReady(() => {
                    if (send(value)) next(); else conn.onReady(next);
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
    return (conn, sink) => {
        const push = conn.writer(sink);
        target.addEventListener(type, push, options);
        return conn.onCleanup(() => target.removeEventListener(type, push, options));
    }
}

/**
 * Convert an iterable to a synchronous event source
 *
 * Each time the resulting source is subscribed to, it will emit an event for
 * each item in the iterator, then close the conduit.  The subscriber must
 * return `true` after each value to continue iteration, or `false` to pause it.
 * (Once paused, it must then call the conduit's {@link Conduit.resume .resume()}
 * method to resume iteration.)
 *
 * @category Stream Producers
 */
export function fromIterable<T>(iterable: Iterable<T>): Source<T> {
    return (conn, sink) => {
        const send = conn.writer(sink), iter = iterable[Symbol.iterator]();
        if (iter.return) conn.onCleanup(() => iter.return());
        return conn.onReady(loop);
        function loop() {
            try {
                for(;;) {
                    const {value, done} = iter.next();
                    if (done) return conn.close();
                    if (!send(value)) return conn.onReady(loop);
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
    return (conn, sink) => {
        Promise.resolve(promise).then(
            v => (conn.push(sink, v), conn.close()),
            e => conn.throw(e)
        )
        return conn;
    }
}

/**
 * Create an event source from a signal (or signal-using function)
 *
 * The resulting event source will emit an event equal to each value
 * the signal or function produces, including its current value at
 * the time of subscription.
 *
 * @category Stream Producers
 */
export function fromSignal<T>(s: () => T): Source<T> {
    s = cached(s);
    return (conn, sink) => {
        let val: T;
        function sendVal() { conn.push(sink, val); val = undefined; }
        effect(() => { val = s(); conn.onReady(sendVal); });
        return conn;
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
 * the subscribe function will be called in its own microtask.)
 *
 * @category Stream Producers
 */
export function fromSubscribe<T>(subscribe: (cb: (val: T) => void) => DisposeFn): Source<T> {
    return (conn, sink) => {
        return conn.onReady(() => conn.onCleanup(subscribe(v => { conn.push(sink, v); })));
    }
}

/**
 * Create a source that emits a single given value
 *
 * @category Stream Producers
 */
export function fromValue<T>(val: T): Source<T> {
    return (conn, sink) => {
        return conn.onReady(() => { conn.push(sink, val); conn.close(); });
    }
}

/**
 * Create an event source that issues a number every `ms` milliseconds (starting
 * with 0 after the first interval passes).
 *
 * @category Stream Producers
 */
export function interval(ms: number): Source<number> {
    return (conn, sink) => {
        let idx = 0;
        const id = setInterval(() => conn.push(sink, idx++), ms);
        return conn.onCleanup(() => clearInterval(id));
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
    return (conn, sink) => factory()(conn, sink)
}

/**
 * A stream that never emits or closes
 *
 * @category Stream Producers
 */
export function never(): Source<never> {
    return (conn) => conn;
}
