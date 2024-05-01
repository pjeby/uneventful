import { log, see, describe, expect, it, useClock, clock, useRoot, noClock, logUncaught } from "./dev_deps.ts";
import {
    start, Suspend, Request, to, resolve, reject, resolver, rejecter, Yielding, must, until, fromIterable,
    IsStream, value, cached, runRules, backpressure, sleep, isHandled, Connection, detached, makeJob,
    CancelError
} from "../src/mod.ts";
import { runPulls } from "../src/scheduling.ts";
import { catchers, defaultCatch } from "../src/internals.ts";

const noop = () => ({ *[Symbol.iterator]() {} });

describe("async start()", () => {
    useRoot();
    useClock();
    describe("with Yieldings", () => {
        it("returns the same job if given a job", () => {
            // Given an existing job
            const j = start(noop);
            // When start() is called on it
            // Then the same job is returned
            expect(start(j)).to.equal(j);
        });
        it("runs generators asynchronously", () => {
            // Given a generator
            const g = (function*() { log("run"); })();
            // When start() is called on it
            start(g);
            // Then the generator should be advanced asynchronously
            see(); clock.tick(0); see("run");
        });
        it("iterates generators of Suspend and calls them", () => {
            // Given an generator yielding Suspend callbacks
            const j = (function*j(){
                yield <Suspend<any>>(r => { log("called first"); resolve(r, 42); });
                yield <Suspend<any>>(r => { log("called second"); resolve(r, 99); });
            })();
            // When made into a job
            start(j);
            // Then they should be called after a tick
            see(); clock.tick(0); see("called first", "called second");
        });
        it("async-throws on throw during cancel", () => {
            // Given a suspended job that throws on resume
            const j = detached.start(function*() {
                try { yield *start(); } finally { throw "whoops!"; }
            });
            clock.tick(0);  // start job
            // When the job is canceled
            j.end()
            // Then the error should propagate
            see("Uncaught: whoops!")
        });
    });
    describe("with functions", () => {
        it("calls the function w/no this if none given", () => {
            // Given a generator function
            const defaultThis = (function(this: any){ return this; })();
            function*g(this: any) { log(this === defaultThis || this == undefined); }
            // When start() is called on it
            start(g);
            // Then the generator should be advanced asynchronously with no this
            see(); clock.tick(0); see("true");
        });
        it("calls the function w/specific this if given", () => {
            // Given an object and a generator function
            const thisArg = {};
            function*g(this: any) { log(this === thisArg); }
            // When start() is called with both
            start(thisArg, g);
            // Then the generator should be advanced asynchronously with the given this
            see(); clock.tick(0); see("true");
        });
    });
});

describe("Job instances", () => {
    useRoot();
    useClock();
    describe("as promises", () => {
        // before(() => setDefer(queueMicrotask));
        noClock();
        // can be async awaited
        describe("can be async awaited", () => {
            it("for values", async () => {
                // Given a job that returns a value
                const j = start(function*() { return 42; });
                // When you await it
                const r = await j
                // Then you get the value
                expect(r).to.equal(42);
            });
            it("for errors", async () => {
                // Given a job that throws
                const j = start(function*() { throw "this in particular"; }).onError(noop);
                // When you await it
                try { await j } catch (e) { log(e); }
                // Then it should throw the error
                see("this in particular");
            });
        });
        // .then()
        describe(".then()", () => {
            it("for values", async () => {
                // Given a job that returns a value
                const j = start(function*() { return 42; });
                // When you await its .then()
                await j.then(v => log(`v:${v}`), e => log(`e:${e}`));
                // Then it should call the value callback
                see("v:42");
            });
            it("for errors", async () => {
                // Given a job that throws
                const j = start(function*() { throw "this in particular"; });
                // When you await its .then()
                await j.then(v => log(`v:${v}`), e => log(`e:${e}`));
                // Then it should call the error callback
                see("e:this in particular");
            });
            it("for cancels", async () => {
                // Given a job that's canceled
                const j = start(); j.end();
                // When you await its .then()
                const e = await j.then(v => log(`v:${v}`), e => { log(`${e.constructor.name}: ${e}`); return e; });
                // Then it should call the error callback with a CancelError
                see("CancelError: Error: Job canceled");
                expect(e).to.be.instanceOf(CancelError);
            });
        });
        describe(".catch()", () => {
            it("for values", async () => {
                // Given a job that returns a value
                const j = start(function*() { return 42; });
                // When you await its .catch()
                await j.catch(e => log(`e:${e}`));
                // Then it should not call the catch callback
                see();
            });
            it("for errors", async () => {
                // Given a job that throws
                const j = start(function*() { throw "this in particular"; });
                // When you await its .catch()
                await j.catch(e => log(`e:${e}`));
                // Then it should call the catch callback
                see("e:this in particular");
            });
        });
        describe(".finally()", () => {
            it("for values", async () => {
                // Given a job that returns a value
                const j = start(function*() { return 42; });
                // When you await its .finally()
                await j.finally(() => log("finally"));
                // Then it should call the finally callback
                see("finally");
            });
            it("for errors", async () => {
                // Given a job that throws
                const j = start(function*() { throw "this in particular"; });
                // When you await its .finally()
                try { await j.finally(() => log("finally")) } catch(e) { log(e); };
                // Then it should call the finally callback and still throw
                see("finally", "this in particular");
            });
        });
    });
    describe("as Yielding", () => {
        noClock();
        describe("can be awaited using yield* in another job", () => {
            describe("when already finished", () => {
                it("for values", async () => {
                    // Given a job that returns a value
                    const j = start(function*() { return 42; });
                    // When awaited in another job
                    await start(function*() { log(yield* j); });
                    // Then it should see the value
                    see("42");
                });
                it("for errors", async () => {
                    // Given a job that throws
                    const j = start(function*() { throw "this in particular"; }).onError(noop);
                    // When awaited in another job
                    await start(function*() { yield* j; }).catch(log);
                    // Then it should throw the error
                    see("this in particular");
                });
                it("for cancels", async () => {
                    // Given a job that throws
                    const j = start(); j.end();
                    // When awaited in another job
                    const e = await start(function*() { yield* j; }).catch(e => { log(e); return e; });
                    // Then it should throw a CancelError
                    see("Error: Job canceled");
                    expect(e).to.be.instanceOf(CancelError);
                });
            });
            describe("when suspended", () => {
                it("for values", async () => {
                    // Given a started, suspended job that returns its response
                    let req: Request<any>
                    const j1 = start(function*(): Yielding<any> { return yield r => req = r; });
                    await Promise.resolve();  // ensure j1 reaches suspend point
                    // And that's awaited in another job
                    const j2 = start(function*() { log(yield* j1); });
                    await Promise.resolve();  // ensure j2 reaches suspend point
                    // When the suspended job is resumed with a value
                    resolve(req, 42);
                    // Then it should see the value
                    see("42");
                });
                it("for errors", async () => {
                    // Given a started, suspended job that returns its response
                    let req: Request<any>
                    const j1 = start(function*(): Yielding<any> { return yield r => req = r; });
                    await Promise.resolve();  // ensure j1 reaches suspend point
                    // And that's awaited in another job
                    const j2 = start(function*() { log(yield* j1); }).onError(noop);
                    await Promise.resolve();  // ensure j2 reaches suspend point
                    // When the suspended job is resumed with an error
                    reject(req, "an error");
                    // Then the waiting job should see the error
                    await j2.catch(log);
                    see("an error");
                });
                it("for cancels", async () => {
                    // Given a started, suspended job that returns its response
                    let req: Request<any>
                    const j1 = start(function*(): Yielding<any> { return yield r => req = r; });
                    await Promise.resolve();  // ensure j1 reaches suspend point
                    // And that's awaited in another job
                    const j2 = start(function*() { log(yield* j1); }).onError(noop);
                    await Promise.resolve();  // ensure j2 reaches suspend point
                    // When the suspended job is canceled
                    j1.end()
                    // Then the waiting should see a CancelError
                    const e = await j2.catch(e => { log(e); return e; });
                    see("Error: Job canceled");
                    expect(e).to.be.instanceOf(CancelError);
                });
            });
        });
    });
    describe("as activities", () => {
        describe(".throw()", () => {
            it("interrupts a suspended job", () => {
                // Given a suspended job
                const j = start(function*() {
                    yield r => setTimeout(resolver(r), 50);
                }).onError(e => log(`err: ${e}`));
                clock.tick(0); // get to suspend
                // When it's throw()n
                j.throw("boom")
                // Then it should receive the error at the suspend point
                see("err: boom");
            });
            it("asynchronously aborts a running job", () => {
                // Given a job that .throw()s itself`
                const j = start(function*() {
                    j.throw("headshot");
                    yield r => setTimeout(resolver(r), 50);
                }).onError(e => log(`err: ${e}`));
                // When it next suspends
                clock.tick(1);
                // Then it should receive the error at the suspend point
                see("err: headshot");
            });
            it("asynchronously aborts a starting job", () => {
                // Given a job
                const j = start(function*() {
                    yield r => setTimeout(resolver(r), 50);
                }).onError(e => log(`err: ${e}`));
                // When it'ts thrown before starting
                j.throw("headshot"); clock.tick(0);
                // Then it should receive the error at the first suspend point
                see("err: headshot");
            });
            it("doesn't affect a completed job", () => {
                // Given a completed job (with a parent to catch the async error)
                const parent = detached.start().onError(noop);
                const j = parent.start(function*() { return 42; });
                clock.tick(0);
                // When throw()n
                j.throw("boom");
                // Then the result is unaffected
                start(function*() { log(yield * j); }); clock.tick(0);
                see("42");
            });
        });
        describe(".return()", () => {
            it("interrupts a suspended job", () => {
                // Given a suspended job
                const j = start(function*(): Yielding<any> {
                    try {
                        yield r => setTimeout(resolver(r), 50);
                    } finally {
                        log("exiting");
                    }
                });
                clock.tick(0); // get to suspend
                // When it's return()ed
                j.return("data")
                // Then it should exit at the suspend point
                see("exiting");
                // And return the value
                start(function*(){ log(yield *j); }); clock.tick(0);
                see("data");
            });
            it("asynchronously aborts a running job", () => {
                // Given a job that .return()s itself`
                const j = start(function*(): Yielding<any> {
                    try {
                        j.return(99);
                        yield r => setTimeout(resolver(r), 50);
                    } finally {
                        log("exiting");
                    }
                });
                // When it next suspends
                clock.tick(1);
                // Then it should exit at the suspend point
                see("exiting");
                // And return the value given
                start(function*(){ log(yield *j); }); clock.tick(0);
                see("99");
            });
            it("asynchronously aborts a starting job", () => {
                // Given a job
                const j = start(function*(): Yielding<any> {
                    try {
                        yield r => setTimeout(resolver(r), 50);
                    } finally {
                        log("exiting");
                    }
                });
                // When it's return()ed before starting
                j.return(99); clock.tick(0);
                // Then it should exit at the suspend point
                see("exiting");
                // And return the value given
                start(function*(){ log(yield *j); }); clock.tick(0);
                see("99");
            });
            it("doesn't affect a completed job", () => {
                // Given a completed job
                const j = start(function*() { return 42; });
                clock.tick(0);
                // When return()ed
                expect(() => j.return(99)).to.throw("Job already ended");
                // Then the result is unaffected
                start(function*(){ log(yield * j); }); clock.tick(0);
                see("42");
            });
        });
    });
    describe("as jobs", () => {
        it("runs its contents in a job", () => {
            // Given a job with a cleanup function
            start(function*() { must(() => log("end")); });
            // When the job finishes
            see(); clock.tick(0);
            // Then the cleanup should run
            see("end");
        });
        describe(".must()", () => {
            it("runs when the job completes", () => {
                // Given an empty job with an must()
                start(noop).must(() => log("end"));
                see();
                // When the job is started
                clock.tick(0);
                // Then the cleanup should run
                see("end");
            });
            it("runs async if registered after completion", () => {
                // Given an empty completed job
                const j = start(noop); clock.tick(0); see();
                // When a cleanup is registered
                j.do(() => log("end")); see();
                // Then the cleanup should run async
                clock.tick(0); see("end");
            });
        });
        describe(".release()", () => {
            it("runs when the job completes", () => {
                // Given an empty job with an must()
                start(noop).release(() => log("end"));
                see();
                // When the job is started
                clock.tick(0);
                // Then the cleanup should run
                see("end");
            });
            it("runs async if registered after completion", () => {
                // Given an empty completed job
                const j = start(noop); clock.tick(0); see();
                // When a release() is registered
                j.release(() => log("end")); see();
                // Then the cleanup should run async
                clock.tick(0); see("end");
            });
            describe("doesn't run if canceled", () => {
                it("when registered before the job", () => {
                    // Given an empty job with a canceled release()
                    start(noop).release(() => log("end"))(); see();
                    // When the job is started
                    clock.tick(0);
                    // Then the cleanup should not run
                    see();
                });
                it("when registered after the job", () => {
                    // Given an empty completed job
                    const j = start(noop); clock.tick(0); see();
                    // When a release() is registered and canceled
                    j.release(() => log("end"))();
                    // Then the cleanup should not run async
                    clock.tick(0); see();
                });
            });
        });
    });
    describe("request continuations that", () => {
        it("require functions to receive the request", () => {
            // Given a job that yields a non-function
            var err: any
            start(function*(){ try { yield; } catch(e) { err = e; } });
            // When it runs
            clock.tick(0);
            // Then it should throw an error
            expect(err).to.be.instanceOf(Error);
            expect(()=>{ throw err; }).to.throw(/Jobs must yield functions/);
        });
        describe("resolve() to a value", () => {
            it("synchronously", async () => {
                // Given a job that yields to a self-response
                start(function*(): Yielding<any> { log(yield r => resolve(r, 42)); })
                // Then it should resolve immediately after it starts
                clock.tick(0); see("42");
            });
            it("asynchronously", () => {
                // Given a started, suspended job that logs its response
                let req: Request<any>
                start(function*(): Yielding<any> { log(yield r => req = r); }); clock.tick(0);
                // When resolved
                resolve(req, 42);
                // Then it should resume immediately
                see("42");
            });
            it("only once", () => {
                // Given a started, suspended job
                let req: Request<any>
                start(function*(): Yielding<any> {
                    log(yield r => req = r);
                    yield r => { setTimeout(resolver(r), 50); }
                    log("complete");
                }); clock.tick(0);
                // When resolved more than once
                resolve(req, 43); resolve(req, 42);
                // Then it should only see the first call
                see("43");
                // And resume at its normal place
                clock.tick(0); see();
                clock.tick(50); see("complete");
            });
        });
        describe("reject() to a throw", () => {
            it("synchronously", async () => {
                // Given a job that yields to a self-reject
                start(function*() { try { yield r => reject(r, "boom!"); } catch (e) { log(e); }; })
                // Then it should resolve immediately after it starts
                clock.tick(0); see("boom!");
            });
            it("asynchronously", () => {
                // Given a started, suspended job that logs its response
                let req: Request<any>
                start(function*(): Yielding<any> { try { log(yield r => req = r); } catch(e) { log(`err: ${e}`)}; });
                clock.tick(0);
                // When rejected
                reject(req, "boom!");
                // Then it should resume immediately
                see("err: boom!");
            });
            it("only once", () => {
                // Given a started, suspended job
                let req: Request<any>
                start(function*(): Yielding<any> {
                    try { log(yield r => req = r); } catch(e) { log(`err: ${e}`)};
                    yield r => { setTimeout(resolver(r), 50); }
                    log("complete");
                }); clock.tick(0);
                // When rejected more than once
                reject(req, "headshot!"); reject(req, "boom!");
                // Then it should only see the first call
                see("err: headshot!");
                // And resume at its normal place
                clock.tick(0); see();
                clock.tick(50); see("complete");
            });
        });
    });
});


describe("Error Handling", () => {
    it("unhandled errors go to direct parent", () => {
        // Given a fresh job with a parent catcher
        const j1 = makeJob(); j1.asyncCatch(e => log("caught"));
        const j2 = j1.start();
        // When the job throws
        j2.throw("thrown");
        // Then the parent should catch it
        see("caught");
    });
    it("goes to detached if no parent", () => {
        // Given a job with no parent
        const j = makeJob();
        // When it throws
        j.throw("boom");
        // Then it should be caught by the detached job
        see("Uncaught: boom")
    });

    describe(".asyncThrow()", () => {
        // reset handler to testing default after tests that tweak it
        afterEach(() => { detached.asyncCatch(logUncaught); });

        it("calls job.throw() if no asyncCatch", () => {
            // Given a job without an asyncCatch
            const j = makeJob().onError(e => log(`Err: ${e}`));
            // When it's async-thrown to
            j.asyncThrow("boom")
            // Then it should have its .throw() called
            see("Err: boom");
        });
        it("calls asyncCatch handler if any", () => {
            // Given a job with an asyncCatch
            const j = makeJob()
                .onError(e => log(`Err: ${e}`))
                .asyncCatch(e => log(`Caught: ${e}`))
            ;
            // When it's async-thrown to
            j.asyncThrow("boom")
            // Then it should have its handler called
            see("Caught: boom");
        });
        it("removes the asyncCatch handler if it throws", () => {
            // Given a job with a handler that throws
            const j = makeJob().asyncCatch(() => { throw "whoops"; });
            // When it's asyncThrown
            j.asyncThrow("boom");
            // Then both errors should be passed up the chain
            see("Uncaught: boom", "Uncaught: whoops");
            // And the handler should be removed
            expect(catchers.has(j)).to.be.false;
        });
        it("resets detached.asyncCatch() if it throws", async () => {
            // Given a throwing handler on the detached job
            detached.asyncCatch(() => { throw "whoops"; });
            // When it's asyncThrown
            detached.asyncThrow("boom");
            await new Promise(res => {setTimeout(res, 0)});
            // Then both errors should be passed up to Promise.reject()
            see("rejected: boom", "rejected: whoops");
            // And the handler should be reset to the default
            expect(catchers.get(detached)).to.equal(defaultCatch);
        });
    });

    describe(".asyncCatch", () => {
        it("removes the handler if given a null", () => {
            // Given a job with a handler
            const j = makeJob().asyncCatch(log);
            expect(catchers.get(j)).to.equal(log);
            // When asyncCatch is called with null
            j.asyncCatch(null);
            // Then the handler should be removed
            expect(catchers.has(j)).to.be.false;
        });
    });
});

describe("Async Ops", () => {
    useRoot();
    useClock();
    function suspendOn(t: Yielding<any>) {
        return start(function*(): Yielding<any> { try { log(yield *t); } catch(e) { log(`err: ${e}`)}; });
    }

    describe("sleep()", () => {
        it("sleeps for the given ms", () => {
            // Given a job, suspended on a sleep()
            const j = suspendOn(sleep(50));
            // When the time expires, the job should resume (and not before)
            clock.tick(49);
            see();
            clock.tick(1);
            see("undefined");
        });
        it("cancels the timeout if ended early", () => {
            // Given a suspended sleep
            const i = sleep(10)[Symbol.iterator]();
            (i.next().value as Suspend<void>)(()=> log("called"));
            // If the iterator is returned (job is canceled)
            i.return()
            // Then the callback should not be invoked
            clock.tick(10);
            see();
        });
    });

    function checkAsyncResume(to: <T>(p: Promise<T>|PromiseLike<T>) => Yielding<T>) {
        it("resolved promises", async () => {
            // Given a job suspended on to() a resolved promise
            suspendOn(to(Promise.resolve(42)));
            // When the job is run and a tick passes
            clock.tick(0); see(); await Promise.resolve();
            // Then the job should see the result
            see("42");
        });
        it("rejected promises", async () => {
            // Given a job suspended on to() a rejected promise
            suspendOn(to(Promise.reject("boom")));
            // When the job is run and a tick passes
            clock.tick(0); see(); await Promise.resolve();
            // Then the job should see the result
            see("err: boom");
        });
    }
    describe("to() resumes with the result of", () => {
        checkAsyncResume(to);
        it("plain values", async () => {
            // Given a job suspended on to() a plain value
            suspendOn(to("wut"));
            // When the job is run and a tick passes
            clock.tick(0); see(); await Promise.resolve();
            // Then the job should see the result
            see("wut");
        });
    });

    describe("until()", () => {
        it("calls `uneventful.until` methods and returns their value", () => {
            // Given an object with an uneventful.until method
            const o = {"uneventful.until"() { log("called"); return 42; }}
            // When until() is called on it
            log(until(o as any))
            // Then it should call the method and return the result
            see("called", "42");
        });
        describe("handles thenables like to()", () => {
            checkAsyncResume(until);
        });
        describe("handles streams", () => {
            it("returning the first value", () => {
                // When a suspended until() on a stream is run
                suspendOn(until(fromIterable([22,23,24]))); clock.runAll();
                // Then it should resume with the first value from the stream
                runPulls(); see("22");
            });
            it("throwing on throw", () => {
                let conn: Connection;
                // When a suspended until() on a throwing stream is run
                suspendOn(until((_,c) => { backpressure(conn = c)(() => c.throw("boom")); return IsStream; }));
                conn.must(r => log(isHandled(r))).do(r => log(isHandled(r)))  // log before-and-after handledness
                clock.runAll();
                // Then the job should throw once pulls run (and mark the error handled)
                runPulls(); see("false", "true", "err: boom");
            });
            it("throwing on early end", () => {
                // When a suspended until() on an empty stream is run
                suspendOn(until(fromIterable([]))); clock.runAll();
                // Then it should throw a stream-ended error
                runPulls(); see("err: Error: Stream ended");
            });
        });
        describe("handles signals", () => {
            it("immediately resuming for a truthy value", () => {
                // When a suspended until() is run on a truthy signal
                suspendOn(until(value(42))); clock.runAll();
                // Then it should immediately resume with the value
                see("42");
            });
            it("asynchronously resuming when signal becomes truthy", () => {
                // Given a falsy value and an until() suspended on it
                const v = value(0);
                suspendOn(until(v)); clock.runAll(); see();
                // When the value becomes true and rules run
                v.set(55); see(); runRules();
                // Then the until should resume with the new value
                see("55");
            });
            it("throwing when a signal throws synchronously", () => {
                // When a suspended until() is run on an immediately throwing signal
                suspendOn(until(cached(() => {throw "boom"}))); clock.runAll();
                // Then it should immediately throw
                see("err: boom");
            });
            it("asynchronously throwing when a signal throws later", () => {
                // Given a falsy, async-throwing signal and an until() suspended on it
                const v = value(0), c = cached(() => { if (v()) throw "boom!";});
                suspendOn(until(c)); clock.runAll(); see();
                // When the signal recomputes as an error
                v.set(55); see(); runRules();
                // Then the until should reject with the error
                see("err: boom!");
            });
        });
        it("throws on non-Waitables", () => {
            // When until() is called on an invalid value
            // Then it throws
            expect(() => until(42 as any)).to.throw(/must be/);
            expect(() => until("42" as any)).to.throw(/must be/);
        });
    });
});

describe("Request Settlers", () => {
    // Given a request
    function req(...args: any[]) { args.forEach(log); }

    describe("resolve(request, val)", () => {
        it("resolves the request with the value", () => {
            // Given a request
            // When it's resolved
            resolve(req, 42);
            // Then the request is called with the right arguments
            see("next", "42");
        });
    });
    describe("reject(request, err)", () => {
        it("rejects the request with the error", () => {
            // Given a request
            // When it's rejected
            reject(req, "boom");
            // Then the request is called with the right arguments
            see("throw", "undefined", "boom");
        });
    });
    describe("resolver(request)(val)", () => {
        it("resolves the request with the value", () => {
            // Given a request
            // When it's resolved
            resolver(req)(42);
            // Then the request is called with the right arguments
            see("next", "42");
        });
    });
    describe("rejecter(request)(err)", () => {
        it("rejects the request with the error", () => {
            // Given a request
            // When it's rejected
            rejecter(req)("boom");
            // Then the request is called with the right arguments
            see("throw", "undefined", "boom");
        });
    });
});