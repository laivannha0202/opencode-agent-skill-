// V16.16 Shared Context Delivery + Structural Budgeting.
//
// Proves the V16.16 production data-flow fix: the child receives ONE canonical
// capsule (stable shared prefix INLINE + delta + run binding) instead of a
// bare snapshot reference plus duplicated task/goal paths. And every budget
// overflow drops WHOLE records with an explicit omission count - a mandatory
// path, command or evidence ref is never cut mid-record, and the final
// model-visible text (headers + notices + metadata) never exceeds the cap.

import test from "node:test"
import assert from "node:assert/strict"

import {
  SNAPSHOT_FACT,
  WAVE_CONTEXT_LIMITS,
  buildCanonicalChildCapsule,
  createChildDelta,
  createWaveSharedSnapshot,
  fitSections,
} from "../lib/wave-shared-context-v16-15.mjs"

const sharedInput = {
  waveId: "wave-1",
  goal: "Ship the widget feature",
  constraints: ["Local verifier remains the ONLY PASS authority."],
  architecture: ["controller owns waves"],
  versionFacts: ["Node >= 22.19"],
  sourceEvidence: [{ ref: "evidence:sha256:abc123", preview: "sandbox metadata schema" }],
  requirementIds: ["R1", "R2"],
  testCommands: [{ command: "node", args: ["--test", "test/w.test.mjs"] }],
  workspaceGeneration: "gen-7",
  symbols: ["createTaskSandbox"],
}

const childInput = {
  childId: "c1",
  taskId: "task-1",
  role: "implement",
  goal: "Implement the widget",
  writeFiles: ["lib/widget.mjs"],
  readFiles: ["lib/base.mjs"],
  acceptance: ["widget renders"],
  verificationCommands: ["node --test test/widget.test.mjs"],
  dependencyReceipts: [{ taskId: "dep-1", status: "done", evidenceRef: "evidence:sha256:dep" }],
  sandboxId: "sb-1",
}

test("V16.16 capsule: the child receives the required shared facts inline", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const capsule = buildCanonicalChildCapsule({
    snapshot,
    child: childInput,
    run: { runId: "run-9", waveId: "wave-1" },
  })
  // Small mandatory shared facts are ACTUALLY delivered, not referenced.
  assert.ok(capsule.text.includes(sharedInput.goal))
  assert.ok(capsule.text.includes(sharedInput.constraints[0]))
  assert.ok(capsule.text.includes("R1"))
  assert.ok(capsule.text.includes("node --test test/w.test.mjs"))
  assert.ok(capsule.text.includes("evidence:sha256:abc123"))
  // ...while large bodies stay references: the preview is not inlined.
  assert.ok(!capsule.text.includes("sandbox metadata schema"))
})

test("V16.16 capsule: no unresolved fake snapshot reference", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const capsule = buildCanonicalChildCapsule({ snapshot, child: childInput, run: { runId: "run-9" } })
  assert.ok(capsule.text.includes(snapshot.snapshotId))
  assert.ok(capsule.text.includes(sharedInput.goal))
  assert.equal(capsule.snapshotId, snapshot.snapshotId)
  // The delta's reference-only sentence is rewritten inside the capsule: the
  // facts ARE above, so the child is never told to resolve an id into nowhere.
  assert.ok(!capsule.text.includes("It is not repeated here by design"))
})

test("V16.16 capsule: task and goal data are not duplicated", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const capsule = buildCanonicalChildCapsule({ snapshot, child: childInput, run: { runId: "run-9" } })
  // The child goal appears once as the task, not three times (delta + task
  // JSON + parent goal) as the old production prompt did.
  const occurrences = capsule.text.split("Implement the widget").length - 1
  assert.ok(occurrences <= 2, `child goal repeated ${occurrences} times`)
  // The parent goal is the snapshot goal: one inline copy, no second copy.
  assert.equal(capsule.text.split(sharedInput.goal).length - 1, 1)
})

test("V16.16 capsule: canonical fields are all present", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const capsule = buildCanonicalChildCapsule({
    snapshot,
    child: childInput,
    run: { runId: "run-9", waveId: "wave-1" },
  })
  for (const required of [
    "task-1",
    "implement",
    "Implement the widget",
    "lib/widget.mjs",
    "lib/base.mjs",
    "widget renders",
    "node --test test/widget.test.mjs",
    "dep-1",
    snapshot.snapshotId,
    "run-9",
    "wave-1",
    "sb-1",
    "scope restriction",
  ]) {
    assert.ok(capsule.text.includes(required), `capsule is missing ${required}`)
  }
  assert.equal(capsule.canProduceVerdict, false)
  assert.equal(capsule.deterministic, true)
})

test("V16.16 capsule: final text respects the exact char budget", () => {
  const snapshot = createWaveSharedSnapshot({
    ...sharedInput,
    goal: "g".repeat(WAVE_CONTEXT_LIMITS.maxGoalChars),
    constraints: Array.from({ length: 12 }, (_, i) => `constraint ${i} `.repeat(30)),
  })
  const capsule = buildCanonicalChildCapsule({
    snapshot,
    child: {
      ...childInput,
      goal: "g".repeat(50_000),
      writeFiles: Array.from({ length: 60 }, (_, i) => `lib/deep/nested/path/file${i}.mjs`),
      acceptance: Array.from({ length: 40 }, (_, i) => `acceptance criterion ${i} `.repeat(20)),
    },
    run: { runId: "run-9" },
    maxChars: 5_500,
  })
  assert.ok(capsule.text.length <= 5_500, `capsule is ${capsule.text.length} chars`)
  assert.equal(capsule.chars.value, capsule.text.length)
})

test("V16.16 structural: no path, command or evidence ref is cut mid-record", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const paths = Array.from({ length: 40 }, (_, i) => `lib/service-${i}/index.mjs`)
  const commands = Array.from({ length: 8 }, (_, i) => `node --test test/suite${i}.test.mjs --flag=value${i}`)
  const capsule = buildCanonicalChildCapsule({
    snapshot,
    child: { ...childInput, writeFiles: paths, verificationCommands: commands },
    run: { runId: "run-9" },
    maxChars: 2_000,
  })
  assert.ok(capsule.text.length <= 2_000)
  // Every path/command record line is either a WHOLE known record or an
  // explicit omission notice: no line may end with a strict prefix of a known
  // path (what a mid-record character cut leaves behind).
  const knownRecords = new Set([...paths, "lib/base.mjs", ...commands, "evidence:sha256:abc123"]);
  for (const line of capsule.text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("- lib/") && !trimmed.startsWith("- node ") && !trimmed.startsWith("- evidence:")) continue
    const body = trimmed.slice(2)
    if (knownRecords.has(body.split(" (")[0]) || knownRecords.has(body)) continue
    // A record line that is not a whole known record must be a notice, and it
    // must not end mid-path: the longest known prefix it carries must end at
    // a record boundary.
    assert.ok(trimmed.includes("omitted") || trimmed.includes("...["), `mid-record cut: ${trimmed}`)
    for (const full of [...paths, ...commands]) {
      if (trimmed.length < full.length && full.startsWith(trimmed.slice(2))) {
        assert.fail(`mid-record cut: ${trimmed}`)
      }
    }
  }
  // An overflow is reported, never silent.
  if (capsule.bounded === false) {
    assert.ok(capsule.omittedSections.length > 0 || capsule.text.includes("omitted"))
  }
})

test("V16.16 structural: fitSections drops whole optional sections first", () => {
  const fitted = fitSections([
    { title: "# Head", lines: ["identity"], mandatory: true },
    { title: "## Mandatory task", lines: ["do the thing"], mandatory: true, prose: true },
    { title: "## Optional notes", lines: ["note ".repeat(500)], mandatory: false },
  ], { maxChars: 200, omissionLabel: "test budget" })
  assert.ok(fitted.text.length <= 200)
  assert.equal(fitted.bounded, false)
  assert.ok(fitted.omitted.includes("## Optional notes"))
  assert.ok(fitted.text.includes("do the thing"))
  assert.ok(fitted.text.includes("test budget"))
})

test("V16.16 structural: snapshot overflow drops optional sections, keeps mandatory refs", () => {
  const snapshot = createWaveSharedSnapshot({
    goal: "g".repeat(WAVE_CONTEXT_LIMITS.maxGoalChars),
    constraints: Array.from({ length: 12 }, (_, i) => `constraint ${i} `.repeat(30)),
    architecture: Array.from({ length: 12 }, (_, i) => `arch ${i} `.repeat(80)),
    versionFacts: Array.from({ length: 16 }, (_, i) => `fact ${i} `.repeat(80)),
    symbols: Array.from({ length: 24 }, (_, i) => `symbol${i}`.repeat(10)),
    requirementIds: ["R1"],
    testCommands: [{ command: "node", args: ["--test"] }],
    sourceEvidence: [{ ref: "evidence:sha256:keepme", preview: "preview ".repeat(40) }],
  })
  assert.ok(snapshot.text.length <= WAVE_CONTEXT_LIMITS.maxSnapshotChars)
  // Mandatory identity survives: requirement, command and the ref line.
  assert.ok(snapshot.text.includes("R1"))
  assert.ok(snapshot.text.includes("node --test"))
  assert.ok(snapshot.text.includes("evidence:sha256:keepme"))
  assert.ok(snapshot.text.includes(snapshot.snapshotId))
  if (snapshot.bounded === false) {
    assert.ok(snapshot.text.includes("truncated to budget"))
  }
})

test("V16.16 delta: reference-only shape is preserved for the accounting path", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const delta = createChildDelta({ snapshot, child: childInput })
  assert.ok(delta.text.includes(snapshot.snapshotId))
  assert.ok(!delta.text.includes(sharedInput.goal))
  assert.ok(delta.text.length <= WAVE_CONTEXT_LIMITS.maxDeltaChars)
  assert.equal(delta.chars.value, delta.text.length)
})

test("V16.16 capsule: volatile run ids sort after the stable prefix", () => {
  const snapshot = createWaveSharedSnapshot(sharedInput)
  const capsule = buildCanonicalChildCapsule({ snapshot, child: childInput, run: { runId: "run-volatile-1" } })
  const goalAt = capsule.text.indexOf(sharedInput.goal)
  const runAt = capsule.text.indexOf("run-volatile-1")
  assert.ok(goalAt >= 0 && runAt >= 0 && goalAt < runAt)
})
