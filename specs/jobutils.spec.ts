import { describe, expect, it, useClock, clock, log, useContext, see, msg } from "./dev_deps.ts";
import { timeout, abortSignal, task, currentContext, getResult, Yieldable, start, root, Work, starting, must, timeoutAfter, TimeoutError, Future, Activity, watchdog } from "../src/mod.ts";

describe("timeout()", () => {
    useClock();
    it("should cancel the task when it expires", () => {
        // Given a context with a timeout
        const work = root.starting(); timeout(10, work);
        expect(work).to.not.be.canceled;
        // When the timeout expires
        clock.tick(10);
        // Then the context should be canceled
        expect(work).to.be.canceled;
    });
    it("should reset timeout if called again", () => {
        // Given a context with a timeout
        const work = root.starting(); timeout(10, work);
        expect(work).to.not.be.canceled;
        // When the timeout is reset before expiring
        clock.tick(9);
        expect(work).to.not.be.canceled;
        timeout(12, work);
        clock.tick(1);
        // Then the context should not be canceled
        expect(work).to.not.be.canceled;
        // Until the new timeout expires
        clock.tick(11);
        expect(work).to.be.canceled;
    });
    it("doesn't time out if set to 0", () => {
        // Given a context with a timeout
        const work = root.starting(); timeout(10, work);
        expect(work).to.not.be.canceled;
        // When the timeout is set to 0 before expiring
        clock.tick(9);
        expect(work).to.not.be.canceled;
        timeout(0, work);
        clock.tick(1);
        // Then the context should not be canceled
        expect(work).to.not.be.canceled;
        // Even much later
        clock.tick(11);
        expect(work).to.not.be.canceled;
    });
    it("defaults to the current context", () => {
        // Given a task with a timeout set inside it
        const task = root.start(() => void timeout(10));
        expect(task).to.not.be.canceled;
        // When the timeout expires
        clock.tick(10);
        // Then the task should be canceled
        expect(task).to.be.canceled;
    });
});

describe("abortSignal", () => {
    it("returns an AbortSignal", () => {
        // Given a context
        const work = root.starting();
        // When abortSignal is called on it
        // Then it should return an AbortSignal
        expect(abortSignal(work)).to.be.instanceOf(AbortSignal)
    });
    it("returns the same AbortSignal for the same context", () => {
        // Given a context
        const work = root.starting();
        // When abortSignal is called on it more than once
        const s1 = abortSignal(work), s2 = abortSignal(work);
        // Then it should return the same AbortSignal
        expect(s1).to.equal(s2);
    });
    it("should return an aborted signal if the context is already ended", () => {
        // Given an ended context's abortSignal
        const work = root.starting(); work.end();
        // Then the signal should be aborted
        const s = abortSignal(work);
        expect(s.aborted).to.be.true;
    });
    it("should abort the signal when the context ends", () => {
        // Given a context's abortSignal
        const work = root.starting(), s = abortSignal(work);
        expect(s.aborted).to.be.false;
        // When the context is ended
        work.end()
        // Then the signal should be aborted
        expect(s.aborted).to.be.true;
    });
    it("should return a new signal when a checkpoint is reset", () => {
        // Given a checkpoint's abortSignal
        const ctx = root.checkpoint(), s1 = abortSignal(ctx);
        expect(s1.aborted).to.be.false;
        // When the checkpoint is reset
        ctx.reset();
        expect(s1.aborted).to.be.true;
        // Then there should be a new abortSignal
        const s2 = abortSignal(ctx);
        expect(s1).not.to.equal(s2);
        // That isn't aborted
        expect(s2.aborted).to.be.false;
    });
});

describe("task()", () => {
    useContext()
    useClock();
    it("passes arguments+this, returning a task", () => {
        // Given a task-wrapped function
        const that = {};
        const t = task(function *(a: number, b: string) {
            log(this === that);
            log(a);
            log(b);
            log((currentContext() as Work<number>).task() === createdTask);
            return 42;
        })
        // When called w/args and a `this`
        const createdTask = t.call(that, 99, "foo"); see();

        // Then the function should be called in a new task
        // that's the same as the return value, with the
        // given `this`
        clock.tick(0); see("true", "99", "foo", "true");

        // And the wrapped function's eventual return
        // goes to the enclosing task
        expect(getResult(createdTask.result()!)).to.equal(42);
    });
    it("only supplies exact arguments", () => {
        // Given a task-wrapped function
        const that = {};
        const t = task(function*(...args) {
            args.forEach(log);
        })
        // When called w/args and a `this`
        t.call(that, 99, "foo"); see();

        // Then the function should be called with only the given arguments
        clock.tick(0); see("99", "foo");
    })
    it("works as a decorator", () => {
        // Given an instance of a class w/a @task-decorated method
        // (experimental/legacy mode)
        class X {
            @task
            *method(a: number, b: string): Yieldable<number> {
                log(this === that);
                log(a);
                log(b);
                log((currentContext() as Work<number>).task() === createdTask);
                return 42;
            }
        }
        const that = new X;
        // When the method is called w/args
        const createdTask = start(that.method(99, "foo")); see();

        // Then the method should be called in a new task
        // that's the same as the return value, with the
        // object as its `this`
        clock.tick(0); see("true", "99", "foo", "true");

        // And the wrapped function's eventual return
        // goes to the enclosing task
        expect(getResult(start(createdTask).result()!)).to.equal(42);

    });
});

describe("starting()", () => {
    useContext()
    useClock()
    it("cleans up on throw", () => {
        expect(() => starting(() => {
            must(msg("cleanup"))
            see()
            throw new Error("dang");
        })).to.throw("dang")
        see("cleanup")
    })
})

describe("timeoutAfter()", () => {
    useContext()
    useClock()
    afterEach(() => void see())

    function expectTimeoutResult(future: Future<unknown>) {
        expect(future).to.have.errorResult
        expect(future.result()?.err).to.be.instanceOf(TimeoutError)
    }

    function taskWithErrorAndCompletionLogging<T>(body: Activity<T>) {
        const task = root.start(body).onError(log).do(() => log("done"))
        expect(task.result()).to.be.undefined
        return task
    }

    it("returns a reusable activity", () => {
        // Given a timeoutAfter
        const t = timeoutAfter(42)
        // When it's used in a task and partly waited for
        const t1 = taskWithErrorAndCompletionLogging(t)
        clock.tick(35)
        // Then it should not have fired
        expect(t1.result()).to.be.undefined
        see()
        // And when a second task is started with it
        const t2 = taskWithErrorAndCompletionLogging(t)
        // Then when the original deadline passes
        clock.tick(7)
        // The first timeout should expire
        see("Error: Timeout reached", "done")
        expectTimeoutResult(t1)
        // But the second timeout shouldn't expire until it too is up
        expect(t2.result()).to.be.undefined
        clock.tick(35)
        see("Error: Timeout reached", "done")
        expectTimeoutResult(t2)
    })
    it("should throw a TimeoutError when it expires", () => {
        // Given a task with a timeout
        const task = taskWithErrorAndCompletionLogging(timeoutAfter(10, "boom!"))
        // When the timeout expires
        clock.tick(10)
        // Then the task should throw a TimeoutError
        expectTimeoutResult(task)
        see("Error: boom!", "done")
    })
})

describe("watchdog()", () => {
    useClock()
    useContext()

    it("should reset timeout if called again", () => {
        // Given a context with a watchdog deadline set
        const work = root.starting().asyncCatch(log)
        const deadline = work.run(watchdog)
        deadline(10)
        // When the timeout is reset before expiring
        clock.tick(9)
        see()
        deadline(12, "12 ms passed")
        clock.tick(1)
        // Then it should not go off
        see()
        // Until the new timeout expires
        clock.tick(11)
        see("Error: 12 ms passed")
    })
    it("doesn't time out if set to 0, reactivates if non-zero", () => {
        // Given a context with a watchdog deadline set
        const work = root.starting().asyncCatch(log)
        const deadline = work.run(watchdog)
        deadline(10)
        // When the timeout is set to 0 before expiring
        clock.tick(9)
        see()
        deadline(0)
        // Then the context should not be canceled
        see()
        // Even much later
        clock.tick(11)
        see()
        // But if the deadline is set again
        deadline(1)
        // And the time is reached
        clock.tick(1)
        // Then it should still go off
        see("Error: Timeout reached")
    })
})
