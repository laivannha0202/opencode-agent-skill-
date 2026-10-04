import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COST_PROVENANCE, reportVerifiedTaskCost } from "../lib/verified-task-cost.mjs";
import {
  ADVISOR_WEIGHT,
  advisorWeight,
  learnerSizeForTests,
  recordAdvisorOutcome,
  resetAdvisorLearnerForTests,
} from "../lib/advisor-benefit-learner.mjs";

describe("verified task cost + advisor benefit learner (V16.4 slice F)", () => {
  it("cost is unavailable without verified PASS", () => {
    const r = reportVerifiedTaskCost({ verifiedPass: false, toolCalls: 10 });
    assert.equal(r.costAvailable, false);
    assert.equal(r.verifiedTaskCost, null);
  });

  it("measured tokens produce a derived total; missing tokens stay null", () => {
    const full = reportVerifiedTaskCost({ verifiedPass: true, providerInputTokens: 1000, providerOutputTokens: 500, toolCalls: 9 });
    assert.equal(full.costAvailable, true);
    assert.equal(full.verifiedTaskCost.providerTokensTotal, 1500);
    assert.equal(full.verifiedTaskCost.provenance, COST_PROVENANCE.DERIVED);
    const partial = reportVerifiedTaskCost({ verifiedPass: true, toolCalls: 9 });
    assert.equal(partial.partial, true);
    assert.equal(partial.verifiedTaskCost, null);
    assert.equal(partial.components.providerInputTokens.value, null);
    assert.equal(partial.components.providerInputTokens.provenance, COST_PROVENANCE.NOT_MEASURED);
  });

  it("learner stays NEUTRAL below the sample floor", () => {
    resetAdvisorLearnerForTests();
    recordAdvisorOutcome({ taskClass: "bug", consulted: true, accepted: true, verifiedPass: true });
    assert.equal(advisorWeight({ taskClass: "bug" }).weight, ADVISOR_WEIGHT.NEUTRAL);
  });

  it("historically beneficial class nudges consult; harmful class stays local", () => {
    resetAdvisorLearnerForTests();
    for (let i = 0; i < 9; i += 1) {
      recordAdvisorOutcome({ taskClass: "ambiguous-bug", consulted: true, accepted: true, verifiedPass: true });
    }
    assert.equal(advisorWeight({ taskClass: "ambiguous-bug" }).weight, ADVISOR_WEIGHT.CONSULT);
    for (let i = 0; i < 9; i += 1) {
      recordAdvisorOutcome({ taskClass: "trivial-fix", consulted: true, accepted: false, verifiedPass: true });
    }
    assert.equal(advisorWeight({ taskClass: "trivial-fix" }).weight, ADVISOR_WEIGHT.LOCAL);
  });

  it("learner state is bounded by GC", () => {
    resetAdvisorLearnerForTests();
    for (let i = 0; i < 600; i += 1) {
      recordAdvisorOutcome({ taskClass: `class-${i}`, consulted: false });
    }
    assert.ok(learnerSizeForTests() <= 500);
  });
});
