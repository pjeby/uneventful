import { fromIterable } from "./sources.ts";
import { Conduit, Sink, Source, Transformer, connect } from "./streams.ts";

/**
 * Output multiple streams' contents in order (from an array/iterable of stream
 * sources)
 *
 * Streams are concatenated in order -- note that this means they need to not be
 * infinite if any subsequent streams are to be processed!  The output is closed
 * when all sources are finished or if any source throws (in which case the
 * error propagates to the subscriber).
 *
 * Note: this function is just shorthand for {@link concatAll}({@link fromIterable}(*sources*)).
 *
 * @category Stream Operators
 */
export function concat<T>(sources: Source<T>[] | Iterable<Source<T>>): Source<T> {
    return concatAll(fromIterable(sources))
}

/**
 * Flatten a source of sources by emitting their contents in series
 *
 * Streams are concatenated in order -- note that this means they need to not be
 * infinite if any subsequent streams are to be processed!  The output is closed
 * when all sources are finished or if any source throws (in which case the
 * error propagates to the subscriber).
 *
 * If you want to switch to a new stream whenever a new source arrives from the
 * input stream, use {@link switchAll} instead.
 *
 * @category Stream Operators
 */
export function concatAll<T>(sources: Source<Source<T>>): Source<T> {
    return (conn, sink) => {
        let inner: Conduit;
        const inputs: Source<T>[] = [];
        const outer = conn.link(sources, s => {
            inputs.push(s); startNext(); return false;
        }).onCleanup(() => {
            if (!inputs.length) conn.close();
        });
        function startNext() {
            if (inner) return;
            if (!inputs.length) return outer.pull();
            const s = inputs.shift();
            inner = conn.link(s, sink).onCleanup(() => {
                inner = undefined;
                startNext();
            }).pull();
        }
        function resume() {
            inner ? inner.pull() : outer.pull();
            conn.onPull(resume);
        }
        return conn.onPull(resume);
    }
}

/**
 * Map each value of a stream to a substream, then concatenate the resulting
 * substreams
 *
 * (This is just shorthand for `compose(map(mapper), concatAll)`.)
 *
 * If you want to switch to a new stream whenever a new event arrives on the
 * input stream, use {@link switchMap} instead.
 *
 * @category Stream Operators
 */
export function concatMap<T,R>(mapper: (v: T, idx: number) => Source<R>): Transformer<T,R> {
    return src => concatAll(map(mapper)(src))
}


/**
 * Create a subset of a stream, based on a filter function (like Array.filter)
 *
 * The filter function receives the current index (zero-based) as well as the
 * current value.  If it returns truth, the value will be passed to the output,
 * otherwise it will be skipped.
 *
 * If the filter function is typed as a Typescript type guard (i.e. as returning
 * `v is SomeType`), then the resulting source will be typed as
 * Source<SomeType>.
 *
 * @category Stream Operators
 */
export function filter<T,R extends T>(filter: (v: T, idx: number) => v is R): Transformer<T,R>;
export function filter<T>(filter: (v: T, idx: number) => boolean): Transformer<T>;
export function filter<T>(filter: (v: T, idx: number) => boolean): Transformer<T> {
    return src => (conn, sink) => {
        let idx = 0; return src(conn, v => filter(v, idx++) ? sink(v, conn) : true);
    }
}

/**
 * Replace each value in a stream using a function (like Array.map)
 *
 * The mapping function receives the current index (zero-based) as well as the
 * current value.
 *
 * @category Stream Operators
 */
export function map<T,R>(mapper: (v: T, idx: number) => R): Transformer<T,R> {
    return src => (conn, sink) => {
        let idx = 0; return src(conn, v => sink(mapper(v, idx++), conn));
    }
}

/**
 * Create an event source by merging an array or iterable of event sources.
 *
 * The resulting source issues events whenever any of the input sources do, and
 * closes once they all do (or throws if any of them do).
 *
 * @category Stream Operators
 */
export function merge<T>(sources: Source<T>[] | Iterable<Source<T>>): Source<T> {
    return mergeAll(fromIterable(sources));
}

/**
 * Create an event source by merging sources from a stream of event sources
 *
 * The resulting source issues events whenever any of the input sources do, and
 * closes once they all do (or throws if any of them do).
 *
 * @category Stream Operators
 */
export function mergeAll<T>(sources: Source<Source<T>>): Source<T> {
    return (conn, sink) => {
        const uplinks: Set<Conduit> = new Set;
        const outer = conn.link(sources, (s) => {
            const c = conn.link(s, sink).onCleanup(() => {
                uplinks.delete(c);
                if (!uplinks.size && !outer.isOpen()) conn.close();
            }).pull();
            uplinks.add(c);
            return true;
        }).onCleanup(() => {
            if (!uplinks.size) conn.close();
        }).pull();
        function resume() {
            uplinks.forEach(u => u.pull());
            conn.onPull(resume);
        }
        return conn.onPull(resume);
    }
}

/**
 * Create an event source by merging sources created by mapping events to sources
 *
 * The resulting source issues events whenever any of the input sources do, and
 * closes once they all do (or throws if any of them do).
 *
 * (Note: this is just shorthand for `compose(map(mapper), mergeAll)`.)
 *
 * @category Stream Operators
 */
export function mergeMap<T,R>(mapper: (v: T, idx: number) => Source<R>): Transformer<T,R> {
    return src => mergeAll(map(mapper)(src));
}

/**
 * Wrap a source to allow multiple subscribers to the same underlying stream
 *
 * The input source will be susbcribed when the output has at least one
 * subscriber, and unsubscribed when the output has no subscribers.  The input
 * will only be paused when all subscribers pause (i.e. all sinks return false),
 * and will be resumed when any subscriber pull()s.  All subscribers are closed
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
    let uplink: Conduit, pulled = false;
    let links = new Set<[sink: Sink<T>, link: Conduit]>;
    return (conn, sink) => {
        const self: [Sink<T>, Conduit] = [sink, conn];
        links.add(self);
        conn.onPull(doPull).onCleanup(() => {
            links.delete(self);
            if (!links.size) uplink?.close();
        });
        if (links.size === 1) {
            uplink = connect(source, v => {
                pulled = false;
                links.forEach(([s,l]) => pulled = l.push(s, v) || pulled)
                return pulled;
            }, null).onCleanup(() => {
                const {reason} = uplink, err = uplink.hasError();
                uplink = undefined;
                links.forEach(([_,l]) => err ? l.throw(reason) : l.close());
            })
        }
        function doPull() {
            if (!pulled) {
                pulled = true;
                uplink?.pull();
            };
            conn.onPull(doPull);
        }
        return conn;
    }
}

/**
 * Skip the first N items from a source
 *
 * (Equivalent to {@link skipWhile}() with a function that checks the index is < n.)
 *
 * @category Stream Operators
 */
export function skip<T>(n: number): Transformer<T> {
    return skipWhile((_, i) => i<n);
}

/**
 * Skip items from a stream until another source produces a value.
 *
 * If the notifier closes without producing a value, the output will
 * be empty.  If the notifier throws, so will the output.
 *
 * @category Stream Operators
 */
export function skipUntil<T>(notifier: Source<any>): Transformer<T> {
    return src => (conn, sink) => {
        let taking = false;
        conn.link(notifier, (_, c) => { taking = true; c.close(); return false; });
        return src(conn, v => taking && sink(v, conn));
    }
}

/**
 * Skip items from a stream until a given condition is false, then output all
 * remaining items.  The condition function is not called again once it returns
 * false.
 *
 * @category Stream Operators
 */
export function skipWhile<T>(condition: (v: T, index: number) => boolean) : Transformer<T> {
    return src => (conn, sink) => {
        let idx = 0, met = false;
        return src(conn, v => (met ||= !condition(v, idx++)) ? sink(v, conn) : true);
    };
}

/**
 * Flatten a source of sources by emitting their contents until a new one
 * arrives.
 *
 * As each source arrives from the input stream, its values are sent to the
 * output, closing the previous one (if any).  The output is closed when both
 * the input stream and the most-recently-arrived stream are finished.  Errors
 * propagate to the output if any stream throws.
 *
 * (If you want to send *all* the values of each stream to the output without
 * stopping, input stream, use {@link concatAll} or {@link mergeAll} instead.)
 *
 * @category Stream Operators
 */
export function switchAll<T>(sources: Source<Source<T>>): Source<T> {
    return (conn, sink) => {
        let inner: Conduit;
        const outer = conn.link(sources, s => {
            inner?.close();
            inner = conn.link(s, sink).onCleanup(() => {
                inner = undefined;
                outer.isOpen() || conn.close();
            }).pull();
            return true;
        }).onCleanup(() => {
            inner || conn.close();
        });
        function resume() {
            inner ? inner.pull() : outer.pull();
            conn.onPull(resume);
        }
        return conn.onPull(resume);
    }
}

/**
 * Map each value of a stream to a substream, then output the resulting
 * substreams until a new value arrives.
 *
 * (This is just shorthand for `compose(map(mapper),`{@link switchAll `switchAll)`}.)
 *
 * (If you want to send *all* the values of each stream to the output without
 * stopping, input stream, use {@link concatMap} or {@link mergeMap} instead.)
 *
 * @category Stream Operators
 */
export function switchMap<T,R>(mapper: (v: T, idx: number) => Source<R>): Transformer<T,R> {
    return src => switchAll(map(mapper)(src))
}

/**
 * Take the first N items from a source
 *
 * (Equivalent to {@link takeWhile}() with a function that checks the index is < n.)
 *
 * @category Stream Operators
 */
export function take<T>(n: number): Transformer<T> {
    return takeWhile((_, i) => i<n);
}

/**
 * Take items from a source until another source produces a value.
 *
 * If the notifier closes without producing a value, this will output all
 * elements of the input.  But if the notifier throws, so will the output.
 *
 * @category Stream Operators
 */
export function takeUntil<T>(notifier: Source<any>): Transformer<T> {
    return src => (conn, sink) => {
        conn.link(notifier, () => { conn.close(); return false; }).pull();
        return src(conn, sink);
    }
}

/**
 * Take items from a stream until a given condition is false, then close the
 * output.  The condition function is not called again after it returns false.
 *
 * If the condition function is typed as a Typescript type guard (i.e. as
 * returning `v is SomeType`), then the resulting source will be typed as
 * Source<SomeType>.
 *
 * @category Stream Operators
 */
export function takeWhile<T,R extends T>(condition: (v: T, idx: number) => v is R): Transformer<T,R>;
export function takeWhile<T>(condition: (v: T, idx: number) => boolean): Transformer<T>;
export function takeWhile<T>(condition: (v: T, index: number) => boolean) : Transformer<T> {
    return src => (conn, sink) => {
        let idx = 0;
        return src(conn, v => condition(v, idx++) ? sink(v, conn) : (conn.close(), false));
    };
}