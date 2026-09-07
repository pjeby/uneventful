import { Yielding, getJob, isJobActive, must, newRoot, root, sleep, start } from "../src/mod.ts"
import { $, expiring, fork, service } from "../src/shared.ts"
import { cached, value } from "../src/signals.ts"
import { clock, describe, expect, it, log, logUncaught, msg, see, useClock, useRoot } from "./dev_deps.ts"

function counter(count=0) { return () => ++count }
function msgCounter(count=0) { return () => { log(`call #${++count}`); return count } }

describe("expiring()", () => {
    it("returns a proxy that becomes inaccessible after job end", () => {
        // Given a job and an object
        const job = root.start(), obj = { x: 42 } as {x: number}

        // When an expiring() proxy is created
        const proxy = job.bind(expiring)(obj)

        // Then the original object should be accessible through the proxy
        expect(proxy.x).to.equal(42)
        proxy.x = 99
        expect(obj.x).to.equal(99)

        // And when the job ends
        job.end()

        // Then the object should no longer be accessible through the proxy
        expect(() => proxy.x).to.throw("Cannot perform 'get' on a proxy that has been revoked")
    })
})

describe("fork()", () => {
    useClock()
    useRoot()

    describe("when called on a generator, returns a generator", () => {
        checkGenerator(() => fork(sleepWithMessage()))
        it("that is the same each time for a given input", () => {
            // Given two generators
            const g1 = sleepWithMessage(), g2 = sleepWithMessage()
            // When each is forked more than once
            const f1a = fork(g1), f1b = fork(g1)
            const f2a = fork(g2), f2b = fork(g2)
            // Then the results should be the same for each generator
            expect(f1a).to.equal(f1b)
            expect(f2a).to.equal(f2b)
            // But different from the ones from the other generator
            expect(f1a).to.not.equal(f2a)
            expect(f1b).to.not.equal(f2b)
        })
        it("that is the input if it was already forked", () => {
            // Given a forked generator
            const f1 = fork(sleepWithMessage())
            // When it is forked
            const f2 = fork(f1)
            // Then it should return the same (already-forked) generator
            expect(f1).to.equal(f2)
        });
    })

    describe("when called on a generator function, returns a generator function", () => {
        it("that passes arguments through", () => {
            // Given a forked generator function that logs its arguments
            const logger = fork(function *(...args: any[]) { args.forEach(log) })
            // When called with various arguments
            logger(1, 2, "buckle your shoe")
            clock.tick(0)
            // Then it should log them
            see("1", "2", "buckle your shoe")
        })
        it("that keeps the same `this`", () => {
            // Given an object with a forked method
            class foo { @fork *method() { log(this === obj) } }
            const obj = new foo;
            // When the method is called
            obj.method()
            clock.tick(0)
            // Then it should see the correct `this`
            see("true")
        })
        checkGenerator(fork(sleepWithMessage))
    })

    /** Fixture */
    function *sleepWithMessage() {
        must(msg("cleanup"))
        log("sleeping")
        yield *sleep(10)
        log("done")
        return 42
    }

    function checkGenerator(genfunc: () => Yielding<number>) {
        it("that proceeds without being waited on", () => {
            // Given a forked generator with a sleep
            const g = genfunc()
            // When time advances
            clock.tick(0)
            // Then the generator should proceed
            see("sleeping")
            clock.tick(10)
            see("done")
            // And return the result when waited on
            start(g).onValue(log)
            clock.tick(0)
            see("42")
        })
        it("that can be waited on by more than one job", () => {
            // Given a forked generator with a sleep, waited on by multiple jobs
            const g = genfunc()
            start(g).onValue(v => log(`j1: ${v}`))
            start(g).onValue(v => log(`j2: ${v}`))
            start(g).onValue(v => log(`j3: ${v}`))
            see()
            clock.tick(0)
            see("sleeping")
            // When the generator finishes
            clock.tick(10)
            // Then all the jobs should receive the result
            see("done", "j1: 42", "j2: 42", "j3: 42")
        })
        it("that doesn't run cleanups until the calling job finishes", () => {
            // Given a forked generator with a cleanup, created in a job
            let g: Yielding<number>
            const j = start(() => { g = genfunc(); })
            // When the generator finishes
            clock.tick(10)
            // Then the cleanup function should not run
            see("sleeping", "done")
            // Until the job is ended
            j.end()
            see("cleanup")
        });
    }
})

describe("service()", () => {
    describe("returns an accessor that", () => {
        useClock()
        afterEach(() => void newRoot().asyncCatch(logUncaught))
        it("calls the factory at most once per root", () => {
            // Given a service for a factory that logs and returns a new value each time
            const svc = service(msgCounter())
            // When it is called more than once
            const r1 = svc(), r2 = svc(), r3 = svc()
            // Then it should not call the factory more than once
            see("call #1")
            // But it should return the same value each timeframe
            expect([r1, r2, r3]).to.deep.equal([1, 1, 1])
            // Until a new root exists
            newRoot().asyncCatch(logUncaught)
            // And Then it should call the factory once again
            const r4 = svc(), r5 = svc(), r6 = svc()
            see("call #2")
            // Returning the same (new) value each time
            expect([r4, r5, r6]).to.deep.equal([2, 2, 2])
        })
        it("releases resources with the root", () => {
            // Given a used service for a factory with cleanups
            const svc = service(() => { must(msg("cleanup")) })
            svc()
            see()
            // When a new root is created
            newRoot().asyncCatch(logUncaught)
            // Then the cleanups should run
            see("cleanup")
        })
        it("creates instances in the root job", () => {
            service(() => log(getJob() === root))()
            see("true")
        })
        it("instantiates classes", () => {
            class foo {}
            expect(service(foo)()).to.be.instanceOf(foo)
        })
        it("blocks reactive reads while creating", () => {
            expect(service(value())).to.throw(/Reactive values can't be used/)
        })
        it("fork()s the factory if it's a generator function", () => {
            // Given an async service
            const svc = service(function*(){})
            // When it is called
            const res = svc()
            // Then it should return a fork()ed generator
            expect(root.run(() => fork(res))).to.equal(res)
            // And when a new root is created after the generator finishes
            clock.tick(0); newRoot().asyncCatch(logUncaught)
            // Then the cached instance should have been discarded
            expect(svc()).to.not.equal(res)
        })
        it("can default to another service", () => {
            // Given a service derived from another service
            const base = service(() => 1), derived = service(base)
            // When the derived service is used
            // Then it should default to the base service's value
            expect(derived()).to.equal(1)
            // And when the derived service is replaced
            derived.replace(() => 2)
            derived.unset()
            // Then the replacement should apply without affecting the base
            expect(derived()).to.equal(2)
            expect(base()).to.equal(1)
        })
        describe("is configurable", () => {
            it("returns values updated by .set() and .unset()", () => {
                // Given a service accessor
                const factory = counter(), svc = service(factory)
                expect(svc()).to.equal(1)
                // When its value is .set()
                svc.set(42)
                // Then calls should return the new value
                expect(svc()).to.equal(42)
                // And when it is .unset()
                svc.unset()
                // Then the factory should re-run
                expect(svc()).to.equal(2)
            })
            it("even before the service is first used", () => {
                // Given a service that has not been resolved yet
                const svc = service(() => 1)
                // When its implementation is replaced
                svc.replace(() => 2)
                // Then the replacement should be used
                expect(svc()).to.equal(2)
            })
            it("by setting a value", () => {
                // Given a service
                const svc = service(counter())
                // When a value is set using the accessor as the key
                svc.set(42)
                // Then the accessor should return the value
                expect(svc()).to.equal(42)
            })
            it("by replacing the implementation and unsetting", () => {
                // Given a resolved service
                const factory = counter(), svc = service(factory)
                expect(svc()).to.equal(1)
                // When its implementation is replaced and the cache unset
                svc.replace(() => 42)
                svc.unset()
                // Then the accessor should use the replacement
                expect(svc()).to.equal(42)
            })
            it("by removing the replacement to restore the default", () => {
                // Given a service whose implementation was replaced and then used
                const svc = service(() => 1)
                svc.replace(() => 2)
                svc.unset()
                expect(svc()).to.equal(2)
                // When the replacement is removed without a substitute
                svc.replace()
                svc.unset()
                // Then the default implementation should be restored
                expect(svc()).to.equal(1)
            })
        })
    })
})

describe("Lazy constants", () => {
    describe("$(factory)", () => {
        useRoot()
        it("returns the same value until newRoot()", () => {
            // Given a function that returns a new value on each call
            const inc = counter()
            // When $() is called on it more than once
            // Then the value should be the same each time
            expect($(inc)).to.equal(1)
            expect($(inc)).to.equal(1)
            expect($(inc)).to.equal(1)
            // And after newRoot() is called
            newRoot().asyncCatch(logUncaught)
            // Then the function should be called again
            expect($(inc)).to.equal(2)
            // And the new value should be cached
            expect($(inc)).to.equal(2)
            expect($(inc)).to.equal(2)
        })
        it("creates a new value after newRoot()", () => {
            // Given a function that returns a new value on each call
            const inc = counter()
            expect($(inc)).to.equal(1)
            expect($(inc)).to.equal(1)
            // When a newRoot is created
            newRoot().asyncCatch(logUncaught)
            // Then the value should be different afterward
            expect($(inc)).to.equal(2)
        })
        it("creates instances without an active job", () => {
            $(() => log(isJobActive()))
            see("false")
        })
        it("blocks reactive reads while creating", () => {
            expect(() => $(value())).to.throw(/Reactive values can't be used/)
        })
        it("uses new() if given an ES6 class", () => {
            class thingy { foo: "bar" }
            const first = $(thingy)
            expect(first).to.be.instanceOf(thingy)
            expect($(thingy)).to.equal(first)
        })
        it("uses new() if given an ES5 class", () => {
            // Given some ES5 classes
            function ES5BaseWithMethods() {}
            ES5BaseWithMethods.prototype.aMethod = function aMethod() {}
            function ES5Subclass () {}
            Object.setPrototypeOf(ES5Subclass.prototype, ES5BaseWithMethods.prototype)

            // When $() is called on a base class
            const base = $(ES5BaseWithMethods)
            // Then it should return an instance of that class
            expect(base).to.be.instanceOf(ES5BaseWithMethods)
            // On every subsequent call
            expect($(ES5BaseWithMethods)).to.equal(base)

            // And when $() is called on the subclass
            const sub = $(ES5Subclass)
            // Then it should return an instance of that class
            expect(sub).to.be.instanceOf(ES5Subclass)
            // On every subsequent call
            expect($(ES5Subclass)).to.equal(sub)
        })
        describe("detects factory cycles", () => {
            function expectCycle(fn: () => unknown) {
                expect(fn).to.throw("Factory depends on itself")
            }
            it("when a factory directly depends on itself", () => {
                // Given a factory whose body re-requests itself (at most once,
                // so a missing check can't recurse forever)
                let calls = 0
                const f: () => number = () => ++calls < 2 ? $(f) : 42
                // When $() is called on it
                // Then a cycle error should be thrown
                expectCycle(() => $(f))
                // And the factory should have been entered only once
                expect(calls).to.equal(1)
            })
            it("between two factories", () => {
                // Given two factories that request each other (each recursing at
                // most once, for the same reason as above)
                let aCalls = 0, bCalls = 0
                const a: () => number = () => ++aCalls < 2 ? $(b) : 1
                const b: () => number = () => ++bCalls < 2 ? $(a) : 2
                // When $() is called on either one
                // Then a cycle error should be thrown
                expectCycle(() => $(a))
            })
            it("even if the cycle point was previously resolved", () => {
                // Given a factory that resolves cleanly, and is resolved once
                let recurse = false, calls = 0
                const f: () => number = () => {
                    if (++calls > 2) return 42     // recursion guard: never recurse forever
                    if (recurse) return $(f)       // self-request on demand
                    return 7
                }
                expect($(f)).to.equal(7)
                // When it is unset, then made to re-request itself during creation
                newRoot().asyncCatch(logUncaught)
                recurse = true
                // Then the cycle error should still be thrown
                expectCycle(() => $(f))
            })
        })
    })
    describe("$``(factory, deps?)", () => {
        it("caches a different value per enclosing signal", () => {
            // Given two signals using the same lexical cache
            const inc = counter(), tick = value(0)
            function get() { tick(); const v = $``(inc); log(v); return v }
            const s1 = cached(get), s2 = cached(get)
            // When called
            // Then they should call the underlying function once each
            expect(s1()).to.equal(1); see("1")
            expect(s2()).to.equal(2); see("2")
            // And then retain the cached values on subsequent calls
            ++tick.value
            expect(s1()).to.equal(1); see("1")
            expect(s2()).to.equal(2); see("2")
        })
        it("cache locations are lexically distinct", () => {
            // Given a signal using two lexical caches
            const inc = counter(), tick = value(0)
            const s = cached(() => { tick(); const v = [$``(inc),  $``(inc)]; log(v); return v.join(",") })
            // When called
            // Then each location should cache its value separately
            expect(s()).to.equal("1,2"); see("1,2")
            // And then retain the cached values on subsequent calls
            ++tick.value
            expect(s()).to.equal("1,2"); see("1,2")
        })
        it("throws if used outside a signal", () => {
            // When $`` is used outside of any signal
            // Then it should throw
            expect(() => $``).to.throw("$``() must be called from a reactive expression")
            // And given a $`` callback
            const cb = cached(() => $``)()
            // When it is used outside a signal
            // Then it should also throw
            expect(() => cb(() => 42)).to.throw("$``() must be called from a reactive expression")
        })
        it("creates instances without a job", () => {
            cached(() => $``(() => log(isJobActive())))()
            see("false")
        })
        it("blocks reactive reads while creating", () => {
            expect(() => cached(() => $``(value()))()).to.throw(/Reactive values can't be used/)
        })
    })
})
