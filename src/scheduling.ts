import { defer } from "./defer.ts";

/** Scheduler state flags */
const enum Is {
    Unset = 0,
    _ = 1,
    Running   = _ << 0,
    Scheduled = _ << 1,
}

/**
 * A generic queue for things that need to be run at-most-once per item
 * per timeframe.
 *
 * @category Jobs and Scheduling
 */
export class RunQueue<K> {
    protected _flags: Is = Is.Unset;
    protected readonly q = new Set<K>();

    constructor(
        /**
         * A single-argument scheduling function (like requestAnimationFrame,
         * setImmediate, or queueMicrotask).  The scheduler will call it from
         * time to time with a single callback.  The scheduling function should
         * then arrange for that callback to be invoked *once* at some future
         * point, when it is the desired time for all pending items on this
         * queue to run.
         */
        protected readonly sched: (cb: () => unknown) => unknown,
        /**
         * A callback to loop over the queue, removing items and performing any
         * necessary operations
         */
        protected readonly reap: (queue: Set<K>) => void
    ) {}

    /** Is this queue currently running? */
    isRunning() { return !!(this._flags & Is.Running); }

    /** Is this queue currently empty? */
    isEmpty() { return !this.q.size; }

    add(subject: K) {
        this.q.size || this._flags & (Is.Running|Is.Scheduled) || this._sched();
        this.q.add(subject);
    }

    delete(subject: any) {
        this.q.delete(subject);
    }

    protected _sched() {
        this._flags |= Is.Scheduled;
        this.sched(this._run);
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

/** @internal */
export const pulls = new RunQueue<{doPull(): void}>(defer, pulls => {
    for (const conn of pulls) { pulls.delete(conn); conn.doPull(); }
})

/** @internal For testing only */
export const runPulls  = pulls.flush;