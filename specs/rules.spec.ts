import { log, see, describe, it, useRoot, msg, expect } from "./dev_deps.ts";
import { must, DisposeFn, root, newRoot } from "../mod.ts";
import { runRules, value, rule, SchedulerFn } from "../src/signals.ts";

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

describe("rule.setScheduler()", () => {
    it("assigns the scheduler of the rule", () => {
        // Given a rule that sets its scheduler
        let cb: () => unknown;
        const s = value<SchedulerFn|undefined>(f => cb = f)
        const r = rule.root(() => {
            rule.setScheduler(s());
            log("run");
        });
        // When the rule is run
        runRules(); see("run");
        // And then rescheduled
        s.set(undefined); see();
        // Then the scheduler should be called
        expect(cb).to.be.a("function");
        // But the rule should not re-run until the new callback is invoked
        runRules(); see(); cb(); see("run");
        // And now it should be back on the default scheduler (due to setting undefined)
        s.set(f => cb = f); runRules(); see("run");
        r();
    });
});

describe("rule.stop()", () => {
    it("throws outside a rule", () => {
        expect(() => rule.stop()).to.throw("No rule active");
    });
    it("stops the running rule w/rollback at end", () => {
        // Given a rule that conditionally stops itself
        const v = value(42)
        rule.root(() => {
            if (v() !== 42) {
                must(msg("stopped"));
                rule.stop();
                log("after stop");
            } else {
                log("ok");
            }
        });
        runRules(); see("ok");
        // When that condition occurs
        // Then the job should be stopped when the rule returns
        v.set(99); runRules(); see("after stop", "stopped");
        // And not run again, even if the condition changes
        v.set(42); runRules(); see();
    });
    it("is bound to the rule where it was retrieved", () => {
        // Given a rule that saves rule.stop
        let f: DisposeFn
        rule.root(() => { f = rule.stop; return msg("stopped"); })
        runRules(); see();
        // When the function is called outside the rule
        f();
        // Then the rule should be stopped
        see("stopped");
    });
});

describe("rule.if()", () => {
    it("doesn't rerun unnecessarily", () => {
        // Given a rule.if() with a multipart condition
        const v1 = value(42), v2 = value(57), s = value("started");
        const job = root.start(() => {
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
        // Or the job ends
        job.end()
        see("stopped")
    });
});

describe("rule.root()", () => {
    it("exits only when the root does", () => {
        // Given a rule.root created in a job
        newRoot()
        const j = root.start(() => {
            rule.root(() => msg("done"))
        })
        runRules()
        see()
        // When the job is ended, the rule should still be active
        j.end()
        see()
        // But when the root is ended
        newRoot()
        // Then the rule should finish
        see("done")
    });
});
