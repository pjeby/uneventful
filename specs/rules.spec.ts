import { log, see, describe, it, useRoot, msg, expect } from "./dev_deps.ts";
import { runRules, value, rule, must, DisposeFn, detached, GenericMethodDecorator } from "../mod.ts";

describe("@rule.method", () => {
    useRoot();
    it("passes `this`+args and creates a rule, returning stop", () => {
        // Given a class instance with a @rule.method
        const v = value(42);
        class X {
            @rule.method
            observe(that: any): DisposeFn|void {
                log(this === that)
                log(v());
                must(msg(`undo ${v()}`));
            }
        }
        const that = new X;

        // When the method is called and rules are run
        const stop = that.observe(that); runRules();

        // Then the rule should trigger and update as normal,
        // seeing a `this` that is the relevant instance
        see("true", "42");
        v.set(99); runRules(); see("undo 42", "true", "99");

        // Until the stop is called
        stop && stop(); see("undo 99");

        // After which it should cease responding
        v.set(23); runRules(); see();
    });
});

describe("rule.stop()", () => {
    it("throws outside a rule", () => {
        expect(() => rule.stop()).to.throw("No rule active");
    });
    it("stops the running rule", () => {
        // Given a rule that conditionally stops itself
        const v = value(42)
        detached.start(() => {
            rule(() => {
                if (v() !== 42) {
                    must(msg("stopped"));
                    rule.stop();
                } else {
                    log("ok");
                }
            })
        })
        runRules(); see("ok");
        // When that condition occurs
        // Then the rule should be stopped
        v.set(99); runRules(); see("stopped");
        // And not run again, even if the condition changes
        v.set(42); runRules(); see();
    });
});

describe("rule.if()", () => {
    it("doesn't rerun unnecessarily", () => {
        // Given a rule.if() with a multipart condition
        const v1 = value(42), v2 = value(57), s = value("started");
        detached.start(() => {
            rule.if(
                () => v1() && v2(),
                () => { log(s()); return msg("stopped"); }
            );
        })
        runRules(); see("started");
        // When its conditions change
        // Then nothing happens unless the truthiness changes
        v2.set(99); runRules(); see();
        v1.set(0); runRules(); see("stopped");
        v1.set(23); runRules(); see("started");
        // Or a dependency of the action changes
        s.set("changed"); runRules(); see("stopped", "changed");
        v2.set(0); runRules(); see("stopped");
        s.set("changed again"); runRules(); see()
        v2.set(58); runRules(); see("changed again");
    });
});