import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideWebEscalation } from "../lib/web-reasoning-escalation.mjs";
import {
  routeWithStructuralEvidence,
  scoreStructuralEvidence,
} from "../lib/web-reasoning-structural.mjs";

describe("structural escalation V2 (V16.4 slice C)", () => {
  it("english hard task escalates", () => {
    const r = decideWebEscalation({ mode: "auto", task: "root cause ambiguous, several possible fixes across modules" });
    assert.equal(r.escalate, true);
  });

  it("vietnamese fallback escalates", () => {
    const r = decideWebEscalation({ mode: "auto", task: "không rõ nguyên nhân, có nhiều cách sửa" });
    assert.equal(r.escalate, true);
    assert.ok(r.signals.length > 0);
  });

  it("structural-only evidence scores grounded", () => {
    const { signals, grounded } = scoreStructuralEvidence({
      affectedSubsystems: 4,
      verifierRetries: 3,
      rootCauseAmbiguous: true,
      crossLayerDependency: true,
      editSiteCandidates: 5,
      retrievalConfidence: 0.2,
    });
    assert.equal(grounded, true);
    assert.ok(signals.length >= 5);
  });

  it("routing matrix: structural beats text skip without grounded fact", () => {
    const r = routeWithStructuralEvidence({
      structural: ["multi-subsystem-task"],
      textSignals: [],
      nonEscalation: ["trivial-one-file-deterministic-fix"],
      groundedSkip: false,
    });
    assert.equal(r.escalate, true);
    assert.equal(r.basis, "structural-evidence");
  });

  it("routing matrix: grounded skip still wins when caller verified it", () => {
    const r = routeWithStructuralEvidence({
      structural: ["multi-subsystem-task"],
      groundedSkip: true,
    });
    assert.equal(r.escalate, false);
    assert.equal(r.basis, "grounded-skip");
  });

  it("easy tasks still skip in AUTO", () => {
    for (const task of ["bump package version to 1.2.4", "fix typo in readme", "rename a variable"]) {
      const r = decideWebEscalation({ mode: "auto", task });
      assert.equal(r.escalate, false, task);
    }
  });

  it("FORCE and OFF semantics unchanged", () => {
    assert.equal(decideWebEscalation({ mode: "force", task: "fix typo" }).escalate, true);
    assert.equal(decideWebEscalation({ mode: "off", task: "ambiguous root cause everywhere" }).escalate, false);
  });
});
