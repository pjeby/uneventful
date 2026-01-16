import { Yielding, must, newRoot, root, sleep, start } from "../mod.ts"
import { $, $cache, expiring, fork, service } from "../src/shared.ts"
import { cached, value } from "../src/signals.ts"
import { clock, describe, expect, it, log, logUncaught, msg, see, useClock, useRoot } from "./dev_deps.ts"

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
        afterEach(() => void newRoot().asyncCatch(logUncaught))
        it("calls the factory at most once per root", () => {
            // Given a service for a factory that logs and returns a new value each time
            let count = 0, svc = service(() => {
                log(`call #${++count}`)
                return count
            })
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
        });
        it("fork()s the factory if it's a generator function", () => {
            // Given an async service
            const svc = service(function*(){})
            // When it is called
            const res = svc()
            // Then it should return a fork()ed generator
            expect(root.run(() => fork(res))).to.equal(res)
        });
    })
})

describe("Singletons and memos", () => {

    function counter(count=0) { return () => ++count }

    describe("$(factory)", () => {
        it("returns the same value until $cache.unset", () => {
            // Given a function that returns a new value on each call
            const inc = counter()
            // When $() is called on it more than once
            // Then the value should be the same each time
            expect($(inc)).to.equal(1)
            expect($(inc)).to.equal(1)
            expect($(inc)).to.equal(1)
            // And when $cache.unset() is called on it
            $cache.unset(inc)
            // Then the function should be called again
            expect($(inc)).to.equal(2)
            // And the new value should be cached
            expect($(inc)).to.equal(2)
            expect($(inc)).to.equal(2)
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
    })
    describe("$cache", () => {
        describe(".set", () => {
            it("overrides the return for a specific factory", () => {
                // Given a factory function with a $cache.set()
                const factory = () => 42
                $cache.set(factory, 21)
                // When $(factory) is called
                // Then the value set is returned
                expect($(factory)).to.equal(21)
                // And if a new value is set
                $cache.set(factory, 19)
                // Then the new value is returned
                expect($(factory)).to.equal(19)
                // Until an .unset is done
                $cache.unset(factory)
                // And then the factory is invoked
                expect($(factory)).to.equal(42)
            })
        })
        describe(".replace", () => {
            it("replaces/unreplaces a factory", () => {
                // Given a factory and a registered replacement
                const factory = () => 42, replaced = () => 21
                $cache.replace(factory, replaced)
                // When $(factory) is called
                // Then the replacement should be invoked
                expect($(factory)).to.equal(21)
                // And even if the replacement is removed
                $cache.replace(factory)
                // Then the replacement's result should still be cached
                expect($(factory)).to.equal(21)
                // Until the cache is unset for that factory
                $cache.unset(factory)
                // And then the original factory should be invoked
                expect($(factory)).to.equal(42)
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
        it("discards the cache when deps change", () => {
            // Given a signal for a $``, dependent on two values (one of which
            // is a dependency)
            const v1 = value(1), v2 = value(2)
            const s = cached(() => {
                log(`outer: ${v1()}`)
                return $``(() => { log(`inner: ${v2()}`); return v1() * v2() }, [v2()])
            })
            // When called more than once with no change of values
            // Then the value should not be recalculated
            expect(s()).to.equal(2); see("outer: 1", "inner: 2")
            expect(s()).to.equal(2); see()
            // And if the only non-dep value is changed
            ++v1.value
            // Then the cached value should be used
            expect(s()).to.equal(2); see("outer: 2")
            // But if the dep value is changed
            ++v2.value
            // Then the cached value should be recomputed
            expect(s()).to.equal(6); see("outer: 2", "inner: 3")
        })
        it("throws if used outside a signal", () => {
            // Given a $``
            const f = $``
            // When it's invoked outside of any signal
            // Then it should throw
            expect(() => f(() => 42)).to.throw("$``() must be called from a reactive expression")
        })
    })
})
