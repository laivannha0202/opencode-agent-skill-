import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DELEGATION_DECISION,
  DELEGATION_ROLES,
  DELEGATION_STOP_REASONS,
  FABRIC_LIMITS,
  buildChildContext,
  cancelAllChildren,
  cancelChild,
  createDelegationSession,
  decideDelegation,
  delegationSummary,
  finalizeChild,
  heartbeatChild,
  planDelegation,
  registerChild,
  sweepChildren,
} from "../lib/subagent-fabric.mjs";
import {
  PARALLEL_BLOCK_REASON,
  PARALLEL_SAFETY,
  assessParallelSafety,
  buildDelegationWaves,
  classifyScope,
} from "../lib/delegation-safety.mjs";

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "ues-subagent-v16-5-"));
}

test("V16.5 fabric: delegates for independence and exploration, stays parent-direct for trivial edits", () => {
  assert.equal(decideDelegation({ task: "Review the staged diff for regressions", requestedRole: "review" }).decision, DELEGATION_DECISION.DELEGATE);
  assert.equal(decideDelegation({ task: "Find all places that handle auth", requestedRole: "explore", repoEvidence: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }).decision, DELEGATION_DECISION.DELEGATE);
  assert.equal(decideDelegation({ task: "Fix the off-by-one in src/a.ts", requestedRole: "implement", repoEvidence: ["src/a.ts"] }).decision, DELEGATION_DECISION.PARENT_DIRECT);
  assert.equal(decideDelegation({ task: "bump the version in package.json", requestedRole: "implement" }).decision, DELEGATION_DECISION.PARENT_DIRECT);
  assert.equal(decideDelegation({ task: "Fix the off-by-one in src/a.ts" }).decision, DELEGATION_DECISION.PARENT_DIRECT);
});

test("V16.5 fabric: delegation reasons are facts about the input", () => {
  const delegate = decideDelegation({ task: "Review the staged diff", requestedRole: "review" });
  assert.ok(delegate.reasons.some((row) => row.signal === "independence-required"));
  const direct = decideDelegation({ task: "Fix the typo in src/a.ts", requestedRole: "implement", repoEvidence: ["src/a.ts"] });
  assert.ok(direct.reasons.some((row) => row.signal === "single-file-target"));
});

test("V16.5 fabric: roles reuse the existing agent catalog", () => {
  const roles = Object.keys(DELEGATION_ROLES).sort();
  assert.deepEqual(roles, ["architecture", "diagnose", "explore", "implement", "review", "test-analysis"]);
  const agents = new Set(Object.values(DELEGATION_ROLES).map((row) => row.agent));
  assert.deepEqual([...agents].sort(), ["architect", "codebase-mapper", "debugger", "executor", "integration-verifier", "reviewer"]);
  for (const spec of Object.values(DELEGATION_ROLES)) {
    assert.ok(Array.isArray(spec.skills) && spec.skills.length > 0);
  }
});

test("V16.5 fabric: planDelegation returns a bounded fresh-context child", () => {
  const plan = planDelegation({ task: "Review the staged diff", requestedRole: "review" });
  assert.equal(plan.decision, DELEGATION_DECISION.DELEGATE);
  assert.equal(plan.children.length, 1);
  const child = plan.children[0];
  assert.equal(child.agent, "reviewer");
  assert.equal(child.readOnly, true);
  assert.equal(child.freshContext, true);
  assert.equal(child.copiesParentConversation, false);
  assert.deepEqual(child.minTools, ["read", "grep", "find", "ls"]);
  assert.ok(plan.activeChildren <= FABRIC_LIMITS.defaultActiveChildren);

  const direct = planDelegation({ task: "bump the version in package.json", requestedRole: "implement" });
  assert.equal(direct.children.length, 0);
});

test("V16.5 fabric: child context is bounded and records what is NOT copied", () => {
  const child = buildChildContext({
    role: "diagnose",
    task: "x".repeat(50_000),
    constraints: ["Do not weaken the verifier"],
    relevantFiles: ["lib/a.ts", "lib/b.ts"],
    symbols: ["resolveAuth"],
    evidenceRefs: ["ev:abc123"],
    skillCapsuleText: "### Required constraints\n- never skip the verifier",
  });
  assert.equal(child.freshContext, true);
  assert.ok(child.notCopied.includes("parent-conversation"));
  assert.ok(child.notCopied.includes("full-skill-bodies"));
  assert.ok(child.notCopied.includes("all-tools"));
  assert.ok(child.text.includes("Do not weaken the verifier"));
  assert.ok(child.text.includes("ev:abc123"));
  assert.ok(child.text.length < 12_000, `child context ${child.text.length}`);
  assert.ok(child.fingerprint.startsWith("child-context:sha256:"));
});

test("V16.5 fabric: child context is deterministic for identical input", () => {
  const input = { role: "explore", task: "find auth", relevantFiles: ["lib/a.ts"] };
  assert.equal(buildChildContext(input).fingerprint, buildChildContext(input).fingerprint);
  assert.equal(buildChildContext(input).text, buildChildContext(input).text);
});

test("V16.5 fabric: depth limit and cycle guard fail closed", () => {
  const session = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  assert.equal(session.depth, 0);
  assert.equal(session.hardMaxDepth, FABRIC_LIMITS.hardMaxDepth);

  const cycle = registerChild(session, { role: "explore", agent: "executor", task: "recurse" });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.reason, DELEGATION_STOP_REASONS.CYCLE_DETECTED);

  const deep = createDelegationSession({ parentId: "p1", parentAgent: "executor", depth: FABRIC_LIMITS.hardMaxDepth });
  const blocked = registerChild(deep, { role: "explore", task: "too deep" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, DELEGATION_STOP_REASONS.DEPTH_EXCEEDED);
});

test("V16.5 fabric: active children are hard-bounded", () => {
  const session = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  assert.equal(registerChild(session, { role: "explore", task: "a" }).ok, true);
  assert.equal(registerChild(session, { role: "diagnose", task: "b" }).ok, true);
  const third = registerChild(session, { role: "review", task: "c" });
  assert.equal(third.ok, false);
  assert.equal(third.reason, DELEGATION_STOP_REASONS.CAPACITY_EXCEEDED);

  const wide = createDelegationSession({ parentId: "p1", parentAgent: "executor", maxActiveChildren: 99 });
  assert.equal(wide.maxActiveChildren, FABRIC_LIMITS.maxActiveChildren);
});

test("V16.5 fabric: cancellation and timeout leave no orphan", () => {
  const session = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  const a = registerChild(session, { role: "explore", task: "a" });
  registerChild(session, { role: "diagnose", task: "b" });
  assert.equal(cancelChild(session, a.child.childId).status, "cancelled");
  assert.equal(cancelChild(session, a.child.childId).alreadyTerminal, true);
  cancelAllChildren(session);
  assert.equal(delegationSummary(session).orphansRemaining, 0);

  const timed = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  const b = registerChild(timed, { role: "explore", task: "b", timeoutMs: 5_000 });
  const swept = sweepChildren(timed, Date.now() + 20_000);
  assert.ok(swept.reaped.includes(b.child.childId));
  assert.equal(timed.children[0].status, "timed-out");
  assert.equal(timed.children[0].stopReason, DELEGATION_STOP_REASONS.TIMEOUT);
});

test("V16.5 fabric: heartbeat is recorded per child", () => {
  const session = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  const a = registerChild(session, { role: "explore", task: "a" });
  const beat = heartbeatChild(session, a.child.childId, { activityMs: 10 });
  assert.equal(beat.ok, true);
  assert.equal(heartbeatChild(session, "unknown").ok, false);
});

test("V16.5 fabric: completion receipt carries no verdict authority", () => {
  const session = createDelegationSession({ parentId: "p1", parentAgent: "executor" });
  const a = registerChild(session, { role: "review", task: "review" });
  const done = finalizeChild(session, a.child.childId, { exitCode: 0, outputRef: "ev:out", handoffRef: "ev:handoff" });
  assert.equal(done.receipt.canProduceVerdict, false);
  assert.equal(done.receipt.permissionGrant, false);
  assert.equal(done.receipt.status, "completed");
  assert.equal(done.receipt.outputRef, "ev:out");
  assert.equal(done.receipt.parentId, "p1");
  assert.equal(done.receipt.depth, 1);
  assert.ok(done.receipt.fingerprint.startsWith("child-receipt:sha256:"));

  const failed = registerChild(session, { role: "review", task: "review again" });
  const bad = finalizeChild(session, failed.child.childId, { exitCode: 1 });
  assert.equal(bad.receipt.status, "failed");
  assert.equal(bad.receipt.canProduceVerdict, false);
});

test("V16.5 parallel: two read-only lanes with disjoint scopes may run together", () => {
  const scopes = [
    { role: "explore-a", readOnly: true, files: ["src/a.ts"], task: "map a" },
    { role: "explore-b", readOnly: true, files: ["src/b.ts"], task: "map b" },
  ];
  const result = assessParallelSafety(scopes);
  assert.equal(result.decision, PARALLEL_SAFETY.ALLOWED);
  const waves = buildDelegationWaves(scopes);
  assert.equal(waves.waveCount, 1);
  assert.equal(waves.parallelWaves, 1);
});

test("V16.5 parallel: overlapping writers are blocked", () => {
  const result = assessParallelSafety([
    { role: "impl-a", readOnly: false, files: ["src/c.ts"], task: "edit c" },
    { role: "impl-b", readOnly: false, files: ["src/c.ts"], task: "edit c again" },
  ]);
  assert.equal(result.decision, PARALLEL_SAFETY.BLOCKED);
  assert.ok(result.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.WRITER_OVERLAP));
  assert.equal(result.overlappingScopeBlocks, 1);
});

test("V16.5 parallel: destructive shell and external side effects are serial-only", () => {
  for (const task of ["git push origin main", "npm publish", "rm -rf build", "deploy to production"]) {
    const scope = classifyScope({ role: "x", readOnly: false, files: ["a.ts"], task });
    assert.equal(scope.parallelClass, "serial-only", task);
  }
});

test("V16.5 parallel: the same mutable service is serial-only", () => {
  const scope = classifyScope({ role: "svc", readOnly: false, files: ["a.ts"], task: "start the dev server" });
  assert.equal(scope.parallelClass, "serial-only");
  assert.equal(scope.mutableService, true);
});

test("V16.5 parallel: duplicate scopes are detected", () => {
  const result = assessParallelSafety([
    { role: "a", readOnly: true, files: ["src/a.ts"], task: "map" },
    { role: "b", readOnly: true, files: ["src/a.ts"], task: "map" },
  ]);
  assert.equal(result.duplicateWork, 1);
});

test("V16.5 parallel: waves never exceed the bounded max", async () => {
  await tempRoot();
  const scopes = Array.from({ length: 6 }, (_, index) => ({ role: `lane-${index}`, readOnly: true, files: [`src/${index}.ts`], task: "map" }));
  const waves = buildDelegationWaves(scopes, { maxParallel: 2 });
  for (const wave of waves.waves) assert.ok(wave.scopes.length <= 2, JSON.stringify(wave.scopes));
  assert.equal(waves.waveCount, 3);
});
