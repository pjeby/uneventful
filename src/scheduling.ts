import { defer } from "./defer.ts";

/** Scheduler state flags */
const enum Is {
    Unset = 0,
    _ = 1,
    Running   = _ << 0,
    Scheduled = _ << 1,
}

/**
 * A generic batch processing queue, implemented as a set.  (So items are
 * processed at most once per batch run.)
 *
 * @template T The type of items that will be in the batch
 *
 * @category Scheduling
 */
export interface Batch<T> {
    /** Is the batch processing function currently running? */
    isRunning(): boolean;

    /** Is the batch currently empty? */
    isEmpty(): boolean;

    /**
     * Add an item to the batch.  Schedules the batch for processing if the
     * batch was empty and is not already scheduled.  (Does nothing if the
     * item is already in the batch.)
     */
    add(item: T): void;

    /** Remove an item from the batch.  (Does not affect the schedule.) */
    delete(item: T): void;

    /** Is the item in the batch? */
    has(item: any): boolean;

    /**
     * Process the batch now by calling the processing function, unless the
     * batch is empty or already running.  If the processing function exits
     * without fully emptying the batch (due to errors, time limits, etc.),
     * another flush will be scheduled via the batch's scheduler (unless one is
     * already scheduled).
     */
    readonly flush: () => void;
}


/**
 * Create a batch processing queue from the given processing loop and scheduling
 * function.
 *
 * @template T The type of items that will be in the batch
 *
 * @param process A function taking a set of items.  It should remove items from
 * the set, usually *before* processing them.  (So that the batch won't
 * perpetually block on that item in case of a persistent error.)  If the
 * processing function doesn't remove all items from the set, another processing
 * pass will be done later.  (This allows you to rate-limit processing, so as
 * not to hog the current thread.)
 *
 * @param sched A single-argument scheduling function (like
 * requestAnimationFrame, setImmediate, or queueMicrotask).  The batch will call
 * it from time to time with a single callback.  The scheduling function should
 * then arrange for that callback to be invoked *once* at some future point,
 * when it is the desired time for pending items to be processed.  If no
 * function is given (or it's undefined/null), {@link defer} is used.
 *
 * @returns a {@link Batch} that items can be added to for later processing.
 *
 * @category Scheduling
 */
export function batch<T>(process: (items: Set<T>) => void, sched?: (cb: () => unknown) => unknown): Batch<T> {
    return new _Batch(process, sched);
}

/**
 * A generic queue for things that need to be run at-most-once per item
 * per timeframe.
 *
 * @category Scheduling
 */
class _Batch<T> implements Batch<T> {
    protected _flags: Is = Is.Unset;
    protected readonly q = new Set<T>();

    constructor(
        protected readonly reap: (queue: Set<T>) => void,
        protected readonly sched: ((cb: () => unknown) => unknown) | undefined | null,
    ) {}

    /** Is this queue currently running? */
    isRunning() { return !!(this._flags & Is.Running); }

    /** Is this queue currently empty? */
    isEmpty() { return !this.q.size; }

    add(subject: T) {
        this.q.size || this._flags & (Is.Running|Is.Scheduled) || this._sched();
        this.q.add(subject);
    }

    delete(subject: any) {
        this.q.delete(subject);
    }

    has(subject: any) {
        return this.q.has(subject);
    }

    protected _sched() {
        this._flags |= Is.Scheduled;
        (this.sched || defer)(this._run);
    }

    protected _run = () => {
        this._flags &= ~Is.Scheduled;
        this.flush();
    }

    /** Run all pending items */
    flush = () => {
        // already running? skip it
        if (this._flags & Is.Running) return;
        const {q: queue} = this;
        // nothing to do? skip it
        if (!queue.size) return;
        this._flags |= Is.Running;
        try {
            this.reap(queue);
        } finally {
            this._flags &= ~Is.Running;
            // schedule again if we're stopping early due to error
            !queue.size || (this._flags & Is.Scheduled) || this._sched();
        }
    }
}
