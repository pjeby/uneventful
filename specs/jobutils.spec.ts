import { describe, expect, it, useClock, clock, log, useRoot, see } from "./dev_deps.ts";
import { timeout, abortSignal, task, getJob, getResult, Yielding, start, root } from "../src/mod.ts";

describe("timeout()", () => {
    useClock();
    it("should cancel the job when it expires", () => {
        // Given a job with a timeout
        const job = root.start(); timeout(10, job);
        expect(job).to.not.be.canceled;
        // When the timeout expires
        clock.tick(10);
        // Then the job should be canceled
        expect(job).to.be.canceled;
    });
    it("should reset timeout if called again", () => {
        // Given a job with a timeout
        const job = root.start(); timeout(10, job);
        expect(job).to.not.be.canceled;
        // When the timeout is reset before expiring
        clock.tick(9);
        expect(job).to.not.be.canceled;
        timeout(12, job);
        clock.tick(1);
        // Then the job should not be canceled
        expect(job).to.not.be.canceled;
        // Until the new timeout expires
        clock.tick(11);
        expect(job).to.be.canceled;
    });
    it("doesn't time out if set to 0", () => {
        // Given a job with a timeout
        const job = root.start(); timeout(10, job);
        expect(job).to.not.be.canceled;
        // When the timeout is set to 0 before expiring
        clock.tick(9);
        expect(job).to.not.be.canceled;
        timeout(0, job);
        clock.tick(1);
        // Then the job should not be canceled
        expect(job).to.not.be.canceled;
        // Even much later
        clock.tick(11);
        expect(job).to.not.be.canceled;
    });
    it("defaults to the current job", () => {
        // Given a job with a timeout set inside it
        const job = root.start(() => timeout(10));
        expect(job).to.not.be.canceled;
        // When the timeout expires
        clock.tick(10);
        // Then the job should be canceled
        expect(job).to.be.canceled;
    });
});

describe("abortSignal", () => {
    it("returns an AbortSignal", () => {
        // Given a job
        const job = root.start();
        // When abortSignal is called on it
        // Then it should return an AbortSignal
        expect(abortSignal(job)).to.be.instanceOf(AbortSignal)
    });
    it("returns the same AbortSignal for the same job", () => {
        // Given a job
        const job = root.start();
        // When abortSignal is called on it more than once
        const s1 = abortSignal(job), s2 = abortSignal(job);
        // Then it should return the same AbortSignal
        expect(s1).to.equal(s2);
    });
    it("should return an aborted signal if the job is already ended", () => {
        // Given an ended job's abortSignal
        const job = root.start(); job.end();
        // Then the signal should be aborted
        const s = abortSignal(job);
        expect(s.aborted).to.be.true;
    });
    it("should abort the signal when the job ends", () => {
        // Given a job's abortSignal
        const job = root.start(), s = abortSignal(job);
        expect(s.aborted).to.be.false;
        // When the job is ended
        job.end()
        // Then the signal should be aborted
        expect(s.aborted).to.be.true;
    });
    it("should return a new signal when the job is restarted", () => {
        // Given a job's abortSignal
        const job = root.start(), s1 = abortSignal(job);
        expect(s1.aborted).to.be.false;
        // When the job is restarted
        job.restart();
        expect(s1.aborted).to.be.true;
        // Then there should be a new abortSignal
        const s2 = abortSignal(job);
        expect(s1).not.to.equal(s2);
        // That isn't aborted
        expect(s2.aborted).to.be.false;
    });
});

describe("task()", () => {
    useRoot()
    useClock();
    it("passes arguments+this, returning a job", () => {
        // Given a task-wrapped function
        const that = {};
        const t = task(function *(a: number, b: string) {
            log(this === that);
            log(a);
            log(b);
            log(getJob() === job);
            return 42;
        })
        // When called w/args and a `this`
        const job = t.call(that, 99, "foo"); see();

        // Then the function should be called in a new job
        // that's the same as the return value, with the
        // given `this`
        clock.tick(0); see("true", "99", "foo", "true");

        // And the wrapped function's eventual return
        // goes to the enclosing job
        expect(getResult(job.result()!)).to.equal(42);
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
            *method(a: number, b: string): Yielding<number> {
                log(this === that);
                log(a);
                log(b);
                log(getJob() === job);
                return 42;
            }
        }
        const that = new X;
        // When the method is called w/args
        const job = start(that.method(99, "foo")); see();

        // Then the method should be called in a new job
        // that's the same as the return value, with the
        // object as its `this`
        clock.tick(0); see("true", "99", "foo", "true");

        // And the wrapped function's eventual return
        // goes to the enclosing job
        expect(getResult(start(job).result()!)).to.equal(42);

    });
});