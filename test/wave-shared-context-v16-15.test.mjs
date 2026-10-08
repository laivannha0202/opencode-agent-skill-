// V16.15 Wave Shared Context + Child Delta + Compact Handoff.
//
// Proves the token-economy mechanism that makes parallel children affordable:
//   * the common context is produced ONCE per wave and is immutable;
//   * every child references the SAME snapshot id instead of a private copy;
//   * the child delta EXCLUDES the shared block entirely;
//   * the duplicated chars avoided are MEASURED, not claimed;
//   * the parent handoff is a compact receipt, never a transcript;
//   * provider tokens stay NOT_MEASURED when the provider reported nothing.

import test from "node:test"
import assert from "node:assert/strict"

import {
  SNAPSHOT_FACT,
  WAVE_CONTEXT_LIMITS,
  createChildDelta,
  createCompactHandoff,
  createWaveSharedSnapshot,
  normalizeEvidenceRef,
  waveContextAccounting,
} from "../lib/wave-shared-context-v16-15.mjs"

const sharedInput = {
  waveId: "wave-1",
  goal: "Add V16.15 parallel execution to the runtime",
  constraints: [
    "Local verifier remains the ONLY PASS authority.",
    "DeepSeek never edits files and never produces PASS.",
  ],
  architecture: [
    "pi/extensions/ues.ts is the controller.",
    "lib/worktree-sandbox.mjs owns isolation and integration.",
  ],
  versionFacts: ["package.json version 16.14.0", "Node >= 22.19"],
  sourceEvidence: [
    { ref: "evidence:sha256:abc123", preview: "worktree sandbox metadata schema" },
    { ref: "evidence:sha256:def456", preview: "fleet limits" },
  ],
  requirementIds: ["R1", "R2"],
  testCommands: [{ command: "node", args: ["--test", "test/x.test.mjs"] }],
  workspaceGeneration: "gen-7",
  symbols: ["createTaskSandbox", "runDelegationWave"],
}

test("V16.15 shared context: the snapshot is produced once and is immutable", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  assert.equal(snapshot.immutable, true)
  assert.equal(snapshot.deterministic, true)
  assert.match(snapshot.snapshotId, /^wave-snapshot:sha256:[0-9a-f]{24}$/)
})

test("V16.15 shared context: identical facts yield an identical snapshot id", () => {
  const first = createWaveSharedSnapshot(sharedInput)
  const second = createWaveSharedSnapshot(sharedInput)
  assert.equal(first.snapshotId, second.snapshotId)
  assert.equal(first.text, second.text)
})

test("V16.15 shared context: different facts yield a different snapshot id", () => {
  const first = createWaveSharedSnapshot(sharedInput)
  const second = createWaveSharedSnapshot({ ...sharedInput, goal: "A different goal entirely" })
  assert.notEqual(first.snapshotId, second.snapshotId)
})

test("V16.15 shared context: the snapshot is bounded", () => {
  const snapshot = createWaveSharedSnapshot({
    ...sharedInput,
    architecture: Array.from({ length: 500 }, (_, index) => `architecture note ${index} `.repeat(50)),
  })
  // Per-entry caps already bound the capsule, so the final truncation is not
  // needed: the output is within budget and the measured char count matches it.
  assert.ok(snapshot.text.length <= WAVE_CONTEXT_LIMITS.maxSnapshotChars)
  assert.equal(snapshot.chars.value, snapshot.text.length)
  assert.equal(snapshot.bounded, true)
  // The entry list is capped, so 500 notes cannot inflate the capsule.
  assert.ok(snapshot.facts[SNAPSHOT_FACT.ARCHITECTURE].length <= WAVE_CONTEXT_LIMITS.maxArchitectureNotes)
})

test("V16.15 shared context: a capsule that overflows the budget is truncated and reported", () => {
  // Fill EVERY bounded list to its cap with long entries so the rendered capsule
  // genuinely exceeds maxSnapshotChars.
  const snapshot = createWaveSharedSnapshot({
    goal: "g".repeat(WAVE_CONTEXT_LIMITS.maxGoalChars),
    constraints: Array.from({ length: WAVE_CONTEXT_LIMITS.maxConstraints }, (_, index) => `constraint ${index} `.repeat(30)),
    architecture: Array.from({ length: WAVE_CONTEXT_LIMITS.maxArchitectureNotes }, (_, index) => `arch ${index} `.repeat(80)),
    versionFacts: Array.from({ length: WAVE_CONTEXT_LIMITS.maxVersionFacts }, (_, index) => `fact ${index} `.repeat(80)),
    symbols: Array.from({ length: WAVE_CONTEXT_LIMITS.maxSymbols }, (_, index) => `symbol${index}`.repeat(10)),
    requirementIds: Array.from({ length: WAVE_CONTEXT_LIMITS.maxEntries }, (_, index) => `R${index + 1}`),
    sourceEvidence: Array.from({ length: WAVE_CONTEXT_LIMITS.maxEvidenceRefs }, (_, index) => ({
      ref: `evidence:sha256:${index}`,
      preview: `preview ${index} `.repeat(40),
    })),
  })
  assert.ok(snapshot.text.length <= WAVE_CONTEXT_LIMITS.maxSnapshotChars)
  assert.ok(snapshot.untruncatedChars.value >= snapshot.text.length)
  if (snapshot.untruncatedChars.value > WAVE_CONTEXT_LIMITS.maxSnapshotChars) {
    assert.equal(snapshot.bounded, false)
    assert.ok(snapshot.text.includes("truncated to budget"))
  }
})

test("V16.15 shared context: absent facts are recorded as absent, never faked", () => {
  const snapshot = createWaveSharedSnapshot({ goal: "only a goal" })
  assert.equal(snapshot.facts[SNAPSHOT_FACT.CONSTRAINTS].length, 0)
  assert.deepEqual(snapshot.facts[SNAPSHOT_FACT.SOURCE_EVIDENCE], [])
  assert.equal(snapshot.facts[SNAPSHOT_FACT.WORKSPACE_GENERATION], null)
})

test("V16.15 shared context: the snapshot carries evidence REFERENCES, not bodies", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const refs = snapshot.facts[SNAPSHOT_FACT.SOURCE_EVIDENCE]
  assert.equal(refs.length, 2)
  for (const ref of refs) {
    assert.match(ref.ref, /^evidence:sha256:/)
    // A preview is bounded; the body is never inlined.
    if (ref.preview) assert.ok(ref.preview.length <= WAVE_CONTEXT_LIMITS.maxEntryPreviewChars)
  }
  assert.ok(!snapshot.text.includes("worktree sandbox metadata schema\n\n\n"))
})

test("V16.15 shared context: an evidence ref preview is truncated to its declared bound", () => {
  const ref = normalizeEvidenceRef({ ref: "evidence:sha256:long", preview: "x".repeat(5_000) })
  assert.ok(ref.preview.length <= WAVE_CONTEXT_LIMITS.maxEntryPreviewChars + 20)
  assert.ok(ref.preview.includes("truncated"))
})

test("V16.15 child delta: every child references the SAME shared snapshot id", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const deltas = ["a", "b", "c"].map((id) => createChildDelta({
    snapshot,
    child: { childId: id, taskId: `task-${id}`, goal: `Implement ${id}`, writeFiles: [`lib/${id}.mjs`] },
  }))
  const ids = new Set(deltas.map((delta) => delta.sharedSnapshotId))
  assert.equal(ids.size, 1)
  assert.equal([...ids][0], snapshot.snapshotId)
})

test("V16.15 child delta: the shared block is NOT repeated inline", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({
    snapshot,
    child: { childId: "a", taskId: "task-a", goal: "Implement a", writeFiles: ["lib/a.mjs"] },
  })
  // The delta names the snapshot, but must not contain the shared goal text or
  // the shared constraint bodies as its own content.
  assert.ok(delta.text.includes(snapshot.snapshotId))
  assert.ok(!delta.text.includes(sharedInput.goal))
  for (const constraint of sharedInput.constraints) {
    assert.ok(!delta.text.includes(constraint), `shared constraint leaked into the delta: ${constraint}`)
  }
})

test("V16.15 child delta: child-specific facts ARE present", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({
    snapshot,
    child: {
      childId: "a",
      taskId: "task-a",
      goal: "Implement the sandbox helper",
      writeFiles: ["lib/sandbox-helper.mjs"],
      readFiles: ["lib/worktree-sandbox.mjs"],
      symbols: ["preflightTaskSandbox"],
      acceptance: ["preflight never mutates the root"],
      verification: ["node --test test/sandbox.test.mjs"],
    },
  })
  assert.ok(delta.text.includes("Implement the sandbox helper"))
  assert.ok(delta.text.includes("lib/sandbox-helper.mjs"))
  assert.ok(delta.text.includes("lib/worktree-sandbox.mjs"))
  assert.ok(delta.text.includes("preflight never mutates the root"))
  assert.deepEqual(delta.writeFiles, ["lib/sandbox-helper.mjs"])
})

test("V16.15 child delta: unrelated context is excluded by construction", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({
    snapshot,
    child: { childId: "a", taskId: "task-a", goal: "small", writeFiles: ["lib/a.mjs"] },
  })
  for (const forbidden of [
    "parent-conversation",
    "wave-shared-block-inline",
    "other-children-context",
    "full-repository",
    "full-skill-bodies",
    "raw-tool-logs",
    "unrelated-prior-attempts",
  ]) {
    assert.ok(delta.notCopied.includes(forbidden), `missing notCopied entry ${forbidden}`)
  }
  // The shared body must not be present.
  assert.ok(!delta.text.includes("## Repository architecture (already established)"))
})

test("V16.15 child delta: a delta is bounded", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({
    snapshot,
    child: {
      childId: "a",
      taskId: "task-a",
      goal: "g".repeat(50_000),
      writeFiles: Array.from({ length: 400 }, (_, index) => `lib/file${index}.mjs`),
      acceptance: Array.from({ length: 400 }, (_, index) => `acceptance criterion ${index} `.repeat(20)),
    },
  })
  assert.ok(delta.text.length <= WAVE_CONTEXT_LIMITS.maxDeltaChars)
  assert.equal(delta.chars.value, delta.text.length)
  // The child's write scope is capped, so a 400-file declaration cannot inflate
  // the delta beyond its budget.
  assert.ok(delta.writeFiles.length <= 40)
})

test("V16.15 child delta: a delta that overflows its budget is truncated and reported", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({
    snapshot,
    child: {
      childId: "a",
      taskId: "task-a",
      goal: "g".repeat(WAVE_CONTEXT_LIMITS.maxChildGoalChars),
      writeFiles: Array.from({ length: 40 }, (_, index) => `lib/${"deep/".repeat(20)}file${index}.mjs`),
      readFiles: Array.from({ length: 40 }, (_, index) => `lib/${"deep/".repeat(20)}read${index}.mjs`),
      acceptance: Array.from({ length: WAVE_CONTEXT_LIMITS.maxChildAcceptance }, (_, index) => `acceptance ${index} `.repeat(30)),
      verification: Array.from({ length: WAVE_CONTEXT_LIMITS.maxChildVerification }, (_, index) => `verify ${index} `.repeat(30)),
      verificationCommands: Array.from({ length: WAVE_CONTEXT_LIMITS.maxChildVerification }, (_, index) => `node --test test/x${index}.test.mjs`),
      symbols: Array.from({ length: WAVE_CONTEXT_LIMITS.maxSymbols }, (_, index) => `symbol${index}`.repeat(10)),
    },
  })
  assert.ok(delta.text.length <= WAVE_CONTEXT_LIMITS.maxDeltaChars)
  assert.ok(delta.untruncatedChars.value >= delta.text.length)
  if (delta.untruncatedChars.value > WAVE_CONTEXT_LIMITS.maxDeltaChars) {
    assert.equal(delta.bounded, false)
    assert.ok(delta.text.includes("truncated to budget"))
  }
})

test("V16.15 child delta: identical child input yields an identical fingerprint", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const child = { childId: "a", taskId: "task-a", goal: "same", writeFiles: ["lib/a.mjs"] }
  const first = createChildDelta({ snapshot, child })
  const second = createChildDelta({ snapshot, child })
  assert.equal(first.fingerprint, second.fingerprint)
})

test("V16.15 accounting: duplicated chars avoided are MEASURED, not claimed", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const deltas = ["a", "b", "c"].map((id) => createChildDelta({
    snapshot,
    child: { childId: id, taskId: `task-${id}`, goal: `Implement ${id}`, writeFiles: [`lib/${id}.mjs`] },
  }))
  const accounting = waveContextAccounting({ snapshot, deltas })

  assert.equal(accounting.childCount, 3)
  assert.equal(accounting.sharedContextChars.value, snapshot.chars.value)
  assert.equal(accounting.sharedContextChars.provenance, "MEASURED")
  // The naive baseline would inline the shared block in every child.
  assert.equal(accounting.duplicateContextCharsAvoided.value, snapshot.chars.value * 2)
  assert.equal(accounting.duplicateContextCharsAvoided.provenance, "MEASURED")
  assert.equal(accounting.provenance.tokens, "NOT_MEASURED")
  assert.equal(accounting.tokenSavingClaim, null)
})

test("V16.15 accounting: a single child has nothing to de-duplicate", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({ snapshot, child: { childId: "a", taskId: "t", goal: "g" } })
  const accounting = waveContextAccounting({ snapshot, deltas: [delta] })
  assert.equal(accounting.duplicateContextCharsAvoided.value, 0)
})

test("V16.15 accounting: no snapshot means no shared chars, never a negative saving", () => {
  const accounting = waveContextAccounting({ snapshot: null, deltas: [] })
  assert.equal(accounting.sharedContextChars.value, 0)
  assert.equal(accounting.duplicateContextCharsAvoided.value, 0)
})

test("V16.15 handoff: the parent receives a compact receipt, not a transcript", () => {
  const handoff = createCompactHandoff({
    child: {
      childId: "ch-1",
      taskId: "task-a",
      sandboxId: "sb-1",
      status: "completed",
      changedFiles: ["lib/a.mjs"],
      readFiles: ["lib/b.mjs"],
      verificationCommands: [{ command: "node", args: ["--test", "test/a.test.mjs"] }],
      verificationResults: [{ command: "node --test", status: "PASS", exitCode: 0 }],
      warnings: ["scope narrowed"],
      durationMs: 1_234,
      toolCalls: 9,
      evidenceRefs: ["evidence:sha256:abc"],
      diffSummary: "+12 -3",
    },
  })
  assert.equal(handoff.status, "completed")
  assert.deepEqual(handoff.changedFiles, ["lib/a.mjs"])
  assert.equal(handoff.verificationResults[0].status, "PASS")
  assert.equal(handoff.durationMs.value, 1_234)
  assert.equal(handoff.durationMs.provenance, "MEASURED")
  // A child receipt is evidence, never a verdict.
  assert.equal(handoff.canProduceVerdict, false)
  assert.equal(handoff.rawLogsInline, false)
})

test("V16.15 handoff: absent metrics are NOT_MEASURED, never a fabricated zero", () => {
  const handoff = createCompactHandoff({ child: { childId: "ch-1", taskId: "task-a", status: "completed" } })
  assert.equal(handoff.durationMs.value, null)
  assert.equal(handoff.durationMs.provenance, "NOT_MEASURED")
  assert.equal(handoff.toolCalls.value, null)
  assert.equal(handoff.toolCalls.provenance, "NOT_MEASURED")
})

test("V16.15 handoff: a first failure is bounded and never a full log", () => {
  const handoff = createCompactHandoff({
    child: {
      childId: "ch-1",
      taskId: "task-a",
      status: "failed",
      firstFailure: "AssertionError: expected 2 but got 1\n" + "stack\n".repeat(5_000),
    },
  })
  assert.ok(handoff.firstFailure.length <= 620)
  assert.ok(handoff.firstFailure.includes("AssertionError"))
})

test("V16.15 handoff: raw logs stay addressable, never inlined", () => {
  const handoff = createCompactHandoff({
    child: { childId: "ch-1", taskId: "task-a", status: "failed", rawLogsRef: "evidence:sha256:log" },
  })
  assert.equal(handoff.rawLogsRef, "evidence:sha256:log")
  assert.equal(handoff.rawLogsInline, false)
})

test("V16.15 shared context: no code path copies a parent conversation", async () => {
  const module = await import("../lib/wave-shared-context-v16-15.mjs")
  const source = Object.keys(module).join(",")
  assert.ok(!source.includes("conversation"))
  // The snapshot builder accepts only explicitly named bounded facts.
  const snapshot = createWaveSharedSnapshot({ conversation: "SECRET PARENT TRANSCRIPT", goal: "real goal" })
  assert.ok(!snapshot.text.includes("SECRET PARENT TRANSCRIPT"))
})
