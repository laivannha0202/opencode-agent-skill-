import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decideWebEscalation } from "../lib/web-reasoning-escalation.mjs";

const corpus = JSON.parse(readFileSync(new URL("../evals/web-reasoning-corpus.json", import.meta.url), "utf8"));

describe("real-task A/B corpus wiring (V16.4 slice G)", () => {
  it("corpus loads with paired task classes", () => {
    assert.equal(corpus.schemaVersion, 1);
    assert.ok(corpus.tasks.length >= 10);
    for (const task of corpus.tasks) {
      assert.ok(task.id && task.class && task.task);
    }
  });

  it("same routing code drives A and B arms deterministically", () => {
    const trivial = corpus.tasks.find((t) => t.id === "trivial-local-01");
    const hard = corpus.tasks.find((t) => t.id === "architecture-01");
    const trivialRoute = decideWebEscalation({ mode: "auto", task: trivial.task, affectedSubsystems: 1 });
    const hardRoute = decideWebEscalation({
      mode: "auto", task: hard.task, affectedSubsystems: 3, localConfidence: 0.3,
    });
    assert.equal(trivialRoute.escalate, false);
    assert.equal(hardRoute.escalate, true);
  });

  it("promotion invariants are expressible: no false pass without verifier", () => {
    // The corpus harness must never present advice as a verdict. This pins the
    // invariant at the routing layer: OFF never consults, FORCE is explicit.
    assert.equal(decideWebEscalation({ mode: "off", task: "anything ambiguous" }).escalate, false);
    assert.equal(decideWebEscalation({ mode: "force", task: "fix typo" }).escalate, true);
  });
});
