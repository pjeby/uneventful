import { log, see, describe, expect, it, useRoot, useClock, clock } from "./dev_deps.ts"
import { sleep, root, Job, start } from "../src/mod.ts"
import { Ext, ext, method } from "../src/ext.ts"
import { expectType } from "ts-expect"

describe("Extensions", () => {

    describe("ext()", () => {
        it("caches the extension per target", () => {
            // Given an ext that tracks and counts calls
            let ct = 0, e = ext((ob: any) => (log("called"), ++ct))

            // When invoked on two different objects
            const o1 = {}, o2 = {}, e1 = e(o1), e2 = e(o2)

            // Then the factory should be called once for each, with different results
            see("called", "called")
            expect(e1).to.equal(1)
            expect(e2).to.equal(2)

            // And when called again on the same objects
            const e1a = e(o1), e2a = e(o2)

            // The same values should be returned, with no additional calls
            expect(e1a).to.equal(1)
            expect(e2a).to.equal(2)
            see()
        })
        it("uses the provided weak map to store extensions", () => {
            // Given a WeakMap and an extension based on it
            const m = new WeakMap
            const e = ext((ob, map) => { return map }, m)
            // When the extension is called on an object
            const ob = {}, v = e(ob)
            // Then it should return the supplied map
            expect(v).to.equal(m)
            // And the map should have an entry for the object
            expect(m.get(ob)).to.equal(m)
        })
    })

    describe("method()", () => {
        it("caches the closure per target", () => {
            // Given a closure factory that tracks creation
            let ct = 0, e = method(
                (ob: any) => (
                    log(`closure created for ${JSON.stringify(ob)}`),
                    (...args) => (
                        log(`called with ${JSON.stringify(args)}`), ob
                    )
                )
            )

            // When invoked on two different objects
            const o1 = {o:1}, o2 = {o:2}
            const e1 = e(o1, "foo", 42), e2 = e(o2, "blue", "canoe", 22)

            // Then the factory should be called once for each, with different results
            see(
                'closure created for {"o":1}', 'called with ["foo",42]',
                'closure created for {"o":2}', 'called with ["blue","canoe",22]',
            )
            expect(e1).to.equal(o1)
            expect(e2).to.equal(o2)

            // And when called again on the same objects
            const e1a = e(o1), e2a = e(o2, 99)

            // The same values should be returned, with no additional closure creation
            expect(e1a).to.equal(o1)
            expect(e2a).to.equal(o2)
            see('called with []', 'called with [99]')
        })
        it("uses the provided weak map to store closures", () => {
            // Given a WeakMap and an extension based on it
            const m = new WeakMap
            const e = method((ob, map) => () => { return map }, m)
            // When the extension is called on an object
            const ob = {}, v = e(ob)
            // Then it should return the supplied map
            expect(v).to.equal(m)
            // And the map should have an entry for the object
            expect(m.get(ob)()).to.equal(m)
        })
    })

    describe("Ext subclasses", () => {
        useRoot()
        class Target { blah: number }
        class Simple extends Ext<Target> {}
        class AsyncExt extends Simple {
            declare readonly __type__: Job<this>
            *setup() {
                // simulate slow init
                yield *sleep(100);
                return this
            }
            static __new__<Class extends typeof AsyncExt>(tgt: Ext.Target<Class>, map: Ext.Map<Class>) {
                map.set(tgt, start((new this(tgt)).setup()))
            }
        }

        describe("subtyping", () => {
            it("inherits altered __type__", () => {
                // Given a subclass of AsyncExt
                class AsyncSub extends AsyncExt {}
                const t = new Target
                // Then it should have properly-extended return types
                expectType<Job<AsyncSub>|undefined>(AsyncSub.get(t))
                expectType<Job<AsyncSub>>(AsyncSub.for(t))
            });
            it("can narrow target types", () => {
                // Given a narrowed target type
                class Subtarget extends Target { fizz: string }
                class SubExt extends Simple { declare readonly of: Subtarget }
                const t = new Subtarget

                // Then it should have narrowed .of types on the static API
                expectType<Subtarget|undefined>(SubExt.get(t)?.of)
                expectType<Subtarget>(SubExt.for(t).of)

                // And TypeScript should require parameters of the narrowed type
                // @ts-expect-error
                SubExt.for(new Target)
                // @ts-expect-error
                SubExt.get(new Target)
            })
        })

        describe(".for()", () => {
            useClock()
            it("caches the extension per target", () => {
                // Given a pair of targets
                const t1 = new Target, t2 = new Target
                // When extensions are created for them
                const e1 = Simple.for(t1), e2 = Simple.for(t2)
                expect(e1).to.be.instanceOf(Simple)
                expect(e2).to.be.instanceOf(Simple)
                // Then future .for() calls should return the same extensions
                expect(Simple.for(t1)).to.equal(e1)
                expect(Simple.for(t2)).to.equal(e2)
            })
            it("has a unique cache per subclass", () => {
                // Given a subclass and a target
                class Sub extends Simple {}
                const t = new Target
                // When base and subclass extensions are fetched for the same target
                const e1 = Simple.for(t), e2 = Sub.for(t)
                // Then they should be instances of the right classes
                expect(e1).to.not.be.instanceOf(Sub)
                expect(e2).to.be.instanceOf(Sub)
            })
            it("calls __new__ to create extensions", () => {
                // Given an Ext subclass with a custom __new__
                class ExtWithNew extends Simple {
                    static __new__<C extends typeof ExtWithNew>(tgt: Ext.Target<C>, map: Ext.Map<C>) {
                        log("create")
                    }
                }
                // When .for() is called
                ExtWithNew.for(new Target)
                // Then the __new__ method is invoked
                see("create")
            })
            it("allows __new__ to create things other than an instance", () => {
                // Given a target
                const t = new Target
                // When an asynchronous-setup extension is accessed for it
                const job = AsyncExt.for(t)
                // Then it should be a job instance
                expect(job).to.be.instanceOf(root.constructor)
                // That has not yet completed
                expect(job.result()).to.be.undefined
                // But eventually yields the underlying instance
                clock.runAll()
                expect(job.result().val).to.be.instanceOf(AsyncExt)
                expect(job.result().val.of).to.equal(t)
            })
        })

        describe(".has()", () => {
            it("returns the existence of an extension for a target", () => {
                // Given a new target
                const t = new Target
                // When it's checked for an extension
                // Then it should not be present
                expect(Simple.has(t)).to.be.false
                // But When an extension is created, and it's checked again
                Simple.for(t)
                // Then .has() should return true
                expect(Simple.has(t)).to.be.true
                // And When the extension is deleted
                Simple.delete(t)
                // Then .has() should be false again
                expect(Simple.has(t)).to.be.false
            })
        })

        describe(".delete()", () => {
            it("Gets rid of the extension", () => {
                const t = new Target
                // Given that an extension exists for a target
                Simple.for(t)
                expect(Simple.has(t)).to.be.true
                // When it's deleted
                Simple.delete(t)
                // Then it should no longer be present
                expect(Simple.has(t)).to.be.false
            })
            it("Calls subclass __del__ if instance present", () => {
                // Given a subclass with a logging __del__
                class WithDel extends Simple {
                    static __del__(tgt: Target) { log(tgt === t) }
                }

                // When an instance is created and deleted
                const t = new Target
                WithDel.for(t)
                WithDel.delete(t)
                // Then __del__ should be called with the target
                see("true")

                // And When a non-existent instance is deleted
                WithDel.delete(new Target)
                // Then __del__ should not be called
                see()
            })
        })

        describe(".get()", () => {
            it("returns an extension if it exists, undefined otherwise", () => {
                // Given a new target
                const t = new Target
                // When it's checked for an extension
                // Then it should not be present
                expect(Simple.get(t)).to.be.undefined
                // But When an extension is created, and it's checked again
                const e = Simple.for(t)
                // Then .get() should return the object
                expect(Simple.get(t)).to.equal(e)
                // And When the extension is deleted
                Simple.delete(t)
                // Then .get() should go be undefined again
                expect(Simple.get(t)).to.be.undefined
            });
        })

        describe("constructor", () => {
            it("sets .of to the target", () => {
                // Given a target
                const t = new Target
                // When a new extension is created for it
                const e = Simple.for(t)
                // Then its .of should be the target
                expect(e.of).to.equal(t)
            })
        })
    })
})
