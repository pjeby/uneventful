import { Yielding, must, newRoot, root, sleep, start } from "../mod.ts";
import { expiring, fork, service } from "../src/shared.ts"
import { clock, describe, expect, it, log, msg, see, useClock, useRoot } from "./dev_deps.ts";

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
        afterEach(() => void newRoot())
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
            newRoot()
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
            newRoot()
            // Then the cleanups should run
            see("cleanup")
        });
    })
})
