import { Target, target } from "../src/shared.ts"
import { Activity, EventuallyReturns, Future, Coroutine, newRoot, noop, root, sleep } from "../src/mod.ts"
import { describe, expect, fluent, it, log, msg, Rig, see, Step, useClock } from "./dev_deps.ts"
import { fx, runRules } from "../src/signals.ts"
import { call } from "../src/utils.ts"

const recipeReturning = <T>(val: T) => function*(): Coroutine<any>{ return val }
const recipeThatLogs = <T>(msg: string, val?: T) => function*(): Coroutine<T> { log(msg); return val! }
const recipeThrowing = <T>(msg: string, val?: T) => function*(): Coroutine<T>{ throw new Error(msg); return val! }

describe("Target instances", () => {
    const _ = TargetRig()
    describe(".used() returns", () => {
        useClock()
        it("false if unused", () => {
            // after create
            _.given.a.newTarget().then.it.should.be.unused()
            _.and.should.still.be.unused().even.after.the.second.call

            // without triggering use itself
            _.given.a.targetWith(recipeThatLogs("started"))
            _.then.it.should.be.unused()
            _.and.after.waiting().there.should.be.noOutput()
            _.but.if.we.mark.it.requested()
            _.then.after.waiting().weShouldSee("started")
        })
        it("true if used", () => {
            checkUsed("()",         _ => _())
            checkUsed("start()",    _ => _.start(() => {}))
            checkUsed("complete()", _ => _.complete(42))
            checkUsed("fail()",     _ => _.fail("boom"))
            function checkUsed<T>(msg: string, transition: Step<Target<T>>) {
                _.given.a.newTarget().that.is.unused(`should be unused before ${msg}`)
                _.when.theTarget(transition)
                _.then.it.should.become.used(`should be used after ${msg}`)
            }
        })
    })
    describe("when called return", () => {
        it("the same object every time", () => {
            const tgt = target()        // Given a target
            tgt().should.equal(tgt())   // Calling it should return the same object
        })
        describe("an awaitable that", () => {
            describe("forwards errors and results", () => {
                it("from .fail()", async () => await
                    _.given.a.newTarget().with.an.observedFuture()
                        .when.failedWith("boom")
                        .then.its.theFuture().should.be.rejectedWith("boom")
                )
                it("from .complete()", async () => await
                    _.given.a.newTarget().with.an.observedFuture()
                        .when.it.is.completedWith(42)
                        .then.its.theFuture().should.eventually.equal(42)
                )
                it("from .start()", async () => {
                    // Used stub
                    await _.given.a.newTarget().that.is.requested()
                        .when.startedWith(job => void job.return(99))
                        .then.its.theFuture().should.eventually.equal(99)
                    // Unused recipe
                    await _.given.a.targetWith(recipeReturning(42))
                        .when.startedWith(job => void job.return(99))
                        .then.its.theFuture().should.eventually.equal(99)
                    // StartObj
                    await _.given.a.newTarget().that.is.requested()
                        .when.startedWith(Promise.resolve(99))
                        .then.its.theFuture().should.eventually.equal(99)
                })
                it("from recipes", async () => {
                    // Generator function
                    await target(recipeReturning(42))().should.eventually.equal(42)
                    // Async function
                    await target(async function() { return 42 })().should.eventually.equal(42)
                    // Promise-returning function
                    await target(() => Promise.resolve(42))().should.eventually.equal(42)
                    // Failing recipe
                    await target(function*(){ throw new Error("whoo")})().should.be.rejectedWith("whoo")
                })
            })
        })
        describe("a yieldable that", () => {
            useClock()
            describe("forwards errors and results", () => {
                it("from .fail()", () => {
                    _.given.a.newTarget().failedWith("boom").that.is.observedByYielding()
                    _.then.after.waiting().weShouldSee("observed:error:boom")
                })
                it("from recipe", () => {
                    _.given.a.targetWith(function*(){ throw new Error("whoo")}).that.is.observedByYielding()
                    _.then.after.waiting(2).weShouldSee("observed:error:whoo")
                })
                it("from .complete()", () => {
                    _.given.a.newTarget().completedWith(42).that.is.observedByYielding()
                    _.then.after.waiting().weShouldSee("observed:42")
                })
                it("from .start() replacing recipe", () => {
                    _.given.a.targetWith(recipeReturning(42))
                        .that.is.startedWith(recipeReturning(99)).and.observedByYielding()
                    _.then.after.waiting().weShouldSee("observed:99")
                })
                it("from a recipe", () => {
                    _.given.a.targetWith(recipeReturning(91)).that.is.observedByYielding()
                    _.then.after.waiting(2).weShouldSee("observed:91")
                })
            })
        })
    })
    describe("Future .result() returns", () => {
        useClock()
        it("nothing if incomplete", () => {
            expect(target()().result()).to.be.undefined
        })
        it("value result if complete", () => {
            // via .complete
            _.given.a.newTarget().completedWith(42).then.theTargetsFuture().should.have.valueResultOf(42)

            // via recipe
            _.given.a.targetWith(recipeReturning(42))
            _.there.should.be.noResult("completion should be async")
            _.but.after.waiting().theTargetsFuture().should.have.valueResultOf(42)

            // via .start()
            _.given.a.newTarget().startedWith(recipeReturning(42))
            _.after.waiting().theTargetsFuture().should.have.valueResultOf(42)
        })

        it("error result if failed", () => {
            // synchronously via .fail()
            _.given.a.newTarget().failedWith("boom").theTargetsFuture().should.have.errorResultOf("boom")

            // asynchronously via recipe
            _.given.a.targetWith( function*(){ throw new Error("boom") } )
            _.and.an.observedFuture().withSuppressedAsyncErrors()
            _.then.after.waiting().theTargetsFuture().should.have.errorResultOf("boom")
        })

        describe("canceled result", () => {
            after(() => void newRoot())
            it("if root ends", () => {
                _.given.a.newTarget().that.is.requested()
                _.when.theRootIsEnded()
                _.then.theTargetsFuture().should.be.canceled
            })
        })

        it("a reactive result if incomplete", () => { root.start(job => {
            try {
                // Given a target
                const tgt = target<number>()

                // and a reactive rule based on its result()
                call(fx(() => log(JSON.stringify(tgt().result() ?? null))))

                // It initially gets no result
                runRules(); see("null")

                // But if the target is completed
                tgt.complete(42)

                // Then it refreshes with the result
                runRules(); see('{"op":"next","val":42}')
            } finally {
                job.end()
            }
        })})
    })

    function blocksUnusedRecipe(
        overrideRecipeWith: () => void,
        shouldFinishWith: Step<Target<any>> = () => _.theTargetsFuture().should.have.valueResultOf(42)
    ) {
        it("never runs an overridden recipe", () => {
            _.given.a.targetWith(recipeThatLogs("started"))  // noisy
            overrideRecipeWith()
            _.after.waiting().there.should.be.noOutput()
            _.even.though.it.finished.and.theTarget(shouldFinishWith)
        })
    }

    describe(".start()", () => {
        useClock()
        throwsIfBlocked(_ => _.start(() => {}))
        blocksUnusedRecipe(() => _.startedWith(recipeReturning(42)))

        describe("sends results and failures to observers", () => {
            it("registered while unused", () => {
                // Success case
                _.given.a.newTarget().startedWith(recipeReturning(42)).and.observedByCallback()
                _.then.after.waiting().weShouldSee("observed:42")

                // Failure case
                _.given.a.newTarget().that.is.startedWith(recipeThrowing("whoo")).and.observedByCallback()
                _.then.after.waiting().weShouldSee("observed:error:whoo")
            })
            it("registered after request", () => {
                // Success case
                _.given.a.newTarget().that.is.observedByCallback()
                _.when.startedWith(recipeReturning(42))
                _.then.after.waiting().weShouldSee("observed:42")

                // Failure case
                _.given.a.newTarget().that.is.observedByCallback()
                _.when.startedWith(recipeThrowing("whoo"))
                _.then.after.waiting().weShouldSee("observed:error:whoo")
            })
        })

        describe("returns", () => {
            it("the target's Future", () => {
                const tgt = target()
                expect(tgt.start(noop)).to.equal(tgt())
            })
        })

        describe("with a body that throws synchronously", () => {
            it("leaves an unused target unused", () => {
                _.given.a.newTarget()
                _.when.doing(startWithSynchronousError.should.throw("whoo"))
                _.then.it.should.still.be.unused()
                // And a retry still works normally:
                _.but.if.startedWith(t => t.start(recipeReturning(42)))
                _.then.after.waiting().theTargetsFuture().should.have.valueResultOf(42)
            })
            it("leaves a requested target retryable", () => {
                _.given.a.newTarget().that.is.requested().and.observedByYielding()
                _.when.doing(startWithSynchronousError.should.throw("whoo"))
                _.then.there.should.be.noResult()
                _.then.after.waiting().weShouldSee().nothing
                _.and.it.should.be.retryable.if.startedWith(recipeReturning(42))
                _.and.after.waiting(1).so.both.jobs.will.complete
                _.then.weShouldSee("observed:42")
            })
            function startWithSynchronousError() {
                _.startedWith(() => { throw new Error("whoo") })
            }
        })
    })

    describe(".complete()", () => {
        useClock()
        throwsIfBlocked(_ => _.complete(99))
        blocksUnusedRecipe(() => _.completedWith(42))

        it("commits a requested target", () => {
            _.given.a.newTarget().that.is.requested().and.completedWith(42)
            _.then.theTargetsFuture().should.have.valueResultOf(42)
        })
    })

    describe(".fail()", () => {
        useClock()
        throwsIfBlocked(_ => _.fail("nope"))
        blocksUnusedRecipe(
            () => _.failedWith("nope"),
            () => _.theTargetsFuture().should.have.errorResultOf("nope")
        )
        it("fails a requested stub", () => {
            _.given.a.newTarget().that.is.requested().and.failedWith("nope")
            _.then.theTargetsFuture().should.have.errorResultOf("nope")
        })
    })

    function throwsIfBlocked(setup: Step<Target<any>>) {
        it('throws "already finished" if completed', () => {
            const tgt = target<number>(); tgt.complete(42)
            expect(() => setup(tgt)).to.throw("already finished")
        })
        it('rethrows original error if failed', () => {
            const tgt = target<number>(); tgt.fail("boom")
            expect(() => setup(tgt)).to.throw("boom")
        })
        it('throws "already started" if started', () => {
            const tgt = target(recipeReturning(99)); tgt().result()
            expect(() => setup(tgt)).to.throw("already started")
        })
    }

    describe("treat an unobserved failure", () => {
        it("as an async error if thrown", async () => {
            _.given.a.targetWith(recipeThrowing("whoo"))
            _.when.it.is.requested()  // but not promised
            _.then.after.doing(await _.unHandledRejections())
                .weShouldSee("Uncaught: Error: whoo")
        })

        it("silently if .fail()ed", async () => {
            _.given.a.newTarget().that.is.requested()  // but not promised
            _.when.it.is.failedWith("whoo")
            _.then.after.doing(await _.unHandledRejections())
                .weShouldSee().nothing
        })
    })
    describe("reset between roots", () => {
        useClock()
        it("re-running the recipe on next use", () => {
            _.given.a.targetWith(recipeThatLogs("recipe"))
            _.when.it.is.requested()
            _.then.after.waiting().weShouldSee("recipe")
            _.and.when.newRootIsCalled()
            _.and.the.target.is.requested().again
            _.then.after.waiting().weShouldSee("recipe").again
        })
        it("forgetting the committed result and returning to unused state", () => {
            _.given.a.newTarget().completedWith(42)
            _.then.it.should.be.used().and.theTargetsFuture().should.have.valueResultOf(42)
            _.but.when.newRootIsCalled()
            _.then.it.should.be.unused().and.there.should.be.noResult()
        })
    })
    describe("can be used to co-ordinate initializing optional APIs by a deadline", () => {
        beforeEach(() => void newRoot())
        after(() => void newRoot())

        /** The signal for services that the app is ready for modules to load */
        const appPrestart = target(function*() { return "uninitialized app instance" })

        /** Deadline for interest in optional features to be registered */
        const startDeadline = target(function*() {
            yield *appPrestart()
            yield *sleep(0)    // Macrotask to allow any other waiters on prestart a chance to run
        })

        /** Shared implementation stub between optional API and main app */
        const implementationStub = target<string>()

        /**
         * The load target used by app-level features - needs to wait for
         * optional API load, but only if it's actually used
         */
        const appLoaded = target(function*() {
            yield *startDeadline()
            if (implementationStub.used()) {
                yield *implementationStub()
                log("loaded with API")
            } else {
                log("loaded without API")
            }
        })

        /** The API exported by another module - used directly by interested consumers */
        const optionalAPI = target(function*() {
            if (startDeadline().result()) throw new Error("too late")
            // Arrange for the stub to be filled in, so the main loader waits on it
            implementationStub.start(function*() { return "API result" })
        })

        it("waiting for the API if used before the deadline", async () => {
            // Given that the API is used during prestart phase
            await appPrestart()
            optionalAPI() // <- used

            // When the app is loaded
            await appLoaded()

            // Then it should have waited for the implementation to load
            expect(implementationStub()).to.have.valueResultOf("API result")
            see("loaded with API")
        })

        it("failing if stub used after the deadline", async () => {
            // Given that the deadline has passed
            await startDeadline()

            // When the API is used afterwards, the check runs and throws
            await optionalAPI().should.be.rejectedWith("too late")

            // Then the provider is rejected as too late
            expect(implementationStub.used()).to.be.false
            expect(optionalAPI()).to.have.errorResultOf("too late")

            // And the app loads without the API
            await appLoaded()
            see("loaded without API")
        })
    })
})

function TargetRig() {
    let theTarget: Target<any>
    afterEach(() => theTarget = undefined!)

    return fluent(new class TargetRig extends Rig {
        theTarget(cb?: Step<Target<any>>) { cb?.(theTarget); return theTarget }
        theTargetsFuture(cb?: Step<Future<any>>) { cb?.(theTarget()); return theTarget() }
        theFuture() { return theTarget() }
        newTarget() { this.targetOf(target())  }
        targetOf(t: Target<any> ) { theTarget = t }
        targetWith(recipe?: EventuallyReturns<any>) { this.targetOf(target(recipe)) }

        observedByCallback() {
            theTarget()
                .onValue(v => log(`observed:${v}`))
                .onError(e => log(`observed:error:${(e as Error)?.message}`))
                .onCancel(msg("canceled"))
        }

        observedByYielding() {
            root.start(function*() {
                try { log(`observed:${yield *theTarget()}`) }
                catch (e) { log(`observed:error:${(e as Error)?.message}`) }
            })
        }

        requested() { theTarget().result() }

        noResult(msg?: string) { expect(theTarget().result(), msg).to.be.undefined }

        observedFuture() { theTarget() }
        withSuppressedAsyncErrors() { theTarget().catch(noop) }

        failedWith(msg: string) { theTarget.fail(msg) }
        completedWith(val: any) { theTarget.complete(val) }
        startedWith(val: Activity<any>) { theTarget.start(val) }

        used(msg = "should be .used()") { expect(theTarget.used(), msg).to.be.true }
        unused(msg = "should not be .used()") { expect(theTarget.used(), msg).to.be.false }

        doing(val: any) {}
        unHandledRejections() {
            // Give the Node event loop has a chance to run
            return new Promise<void>(res => setTimeout(() => res(), 0))
        }
    })
}
