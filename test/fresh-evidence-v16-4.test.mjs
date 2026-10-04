import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeFollowUpDelta,
  gateFollowUpDispatch,
  snapshotRepositoryEvidence,
} from "../lib/fresh-evidence.mjs";
import {
  FOLLOW_UP_BUDGET,
  accountExternalSubmit,
  maySendSecondFollowUp,
  normalizeFollowUpBudget,
} from "../lib/followup-budget.mjs";
import { WEB_LANE_LIMIT } from "../lib/web-reasoning-lane.mjs";

describe("fresh evidence follow-up (V16.4 slice D)", () => {
  it("canonical default is one follow-up with hard max two", () => {
    assert.equal(FOLLOW_UP_BUDGET.defaultMaxFollowUps, 1);
    assert.equal(FOLLOW_UP_BUDGET.hardMaxFollowUps, 2);
    assert.equal(WEB_LANE_LIMIT.maxFollowUps, 1);
    assert.equal(normalizeFollowUpBudget(undefined), 1);
    assert.equal(normalizeFollowUpBudget(9), 2);
  });

  it("file change between consult and follow-up is detected with provenance", () => {
    const seen = snapshotRepositoryEvidence({ files: { "a.mjs": "v1" }, diff: "d1", diagnostics: [], failingTests: ["t1"] });
    const current = snapshotRepositoryEvidence({ files: { "a.mjs": "v2" }, diff: "d1", diagnostics: [], failingTests: ["t1"] });
    const delta = computeFollowUpDelta(seen, current);
    assert.equal(delta.changed, true);
    assert.deepEqual(delta.changedFiles, ["a.mjs"]);
    assert.ok(delta.changedSections.includes("exactRelevantSnippets"));
    assert.equal(delta.provenance, "local-repository-refresh");
  });

  it("stale knownFiles are not accepted: refresh failure fails closed", () => {
    const gate = gateFollowUpDispatch({ files: {} }, null, { refreshOk: false });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "stale-repository-state");
  });

  it("no-change delta sends nothing redundant", () => {
    const seen = snapshotRepositoryEvidence({ files: { "a.mjs": "v1" } });
    const gate = gateFollowUpDispatch(seen, snapshotRepositoryEvidence({ files: { "a.mjs": "v1" } }), { refreshOk: true });
    assert.equal(gate.ok, true);
    assert.equal(gate.sendDelta, false);
  });

  it("second follow-up denied without new evidence, allowed with verified delta", () => {
    const denied = maySendSecondFollowUp({ followUpsSent: 1 }, { freshVerifierEvidence: false });
    assert.equal(denied.allowed, false);
    const allowed = maySendSecondFollowUp(
      { followUpsSent: 1 },
      { freshVerifierEvidence: true, fingerprintChanged: true, firstResolved: false, benefitExceedsCost: true, submitBudgetAllows: true, sessionHealthy: true },
    );
    assert.equal(allowed.allowed, true);
    const capped = maySendSecondFollowUp(
      { followUpsSent: 2 },
      { freshVerifierEvidence: true, fingerprintChanged: true, firstResolved: false, benefitExceedsCost: true, submitBudgetAllows: true, sessionHealthy: true },
    );
    assert.equal(capped.allowed, false);
  });

  it("external submits have zero automatic retry and explicit accounting", () => {
    const ledger = accountExternalSubmit({ submitted: 0, budget: 1 }, 1);
    assert.equal(ledger.automaticRetries, 0);
    assert.equal(ledger.remaining, 0);
    assert.equal(accountExternalSubmit(ledger, 1).exceeded, true);
  });
});
