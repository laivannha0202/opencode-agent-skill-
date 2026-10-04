// Sections G, H, I, J, K: the V16.6 surface-economy and reporting layer.
//
//   G  tool description profiles (full | compact | minimal)
//   H  stable-prefix drift guard (CACHE | BALANCED | TOKEN)
//   I  Progress Observer V2 (compact | detailed | off)
//   J  parallel read-only reasoning overlap (fail-closed)
//   K  tool-output economy + telemetry provenance
//
// The safety properties asserted here: a narrowed description never loses a
// protective line, drift is report-only, the observer never emits a secret or a
// chain of thought, overlap never hides a write, and compression never removes
// preserved evidence.

import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_TOOL_DESCRIPTION_PROFILE,
  PROFILE_LIMITS,
  TOOL_DESCRIPTION_PROFILES,
  describeToolForProfile,
  profileToolSurface,
  resolveToolDescriptionProfile,
} from "../lib/tool-description-profiles-v16-6.mjs"
import {
  DRIFT_BUDGETS,
  DRIFT_MODES,
  commonPrefixLength,
  guardPrefixDrift,
  prefixFingerprint,
  resolveDriftBudget,
} from "../lib/prefix-drift-guard-v16-6.mjs"
import {
  PROGRESS_MODES,
  createProgressObserverV2,
  observerSecretScan,
  observerHeaderV2,
  progressTelemetryV2,
  recordProgressV2,
  renderProgressV2,
  resolveProgressMode,
  sanitizeNote,
  summarizeProgressV2,
  upsertLaneV2,
} from "../lib/progress-observer-v2.mjs"
import {
  FORBIDDEN_DURING_OVERLAP,
  READ_ONLY_OPERATIONS,
  createParallelReasoningState,
  guardOverlapWindow,
  parallelReasoningTelemetry,
  planParallelReasoning,
} from "../lib/parallel-reasoning-v16-6.mjs"
import {
  assertNoLossyTransform,
  compressRepetitiveOutput,
  detectNoiseFamilies,
  toolOutputEconomyTelemetry,
} from "../lib/tool-output-economy-v16-6.mjs"
import { buildTaskTelemetry } from "../lib/run-telemetry.mjs"
import { computeOrchestrationBudget } from "../lib/orchestration-budget-v16-6.mjs"

const SAFETY_DESCRIPTION = [
  "Apply fail-closed hash-anchored edits.",
  "- A stale or mismatched anchor is rejected.",
  "- Re-read with ues_code instead of fuzzy retrying.",
  "- Writes are workspace-contained and never touch .env files.",
].join("\n")

test("G1: full is byte-identical and is the default", () => {
  const row = resolveToolDescriptionProfile({ env: {} })
  assert.equal(row.profile, DEFAULT_TOOL_DESCRIPTION_PROFILE)
  assert.equal(row.profile, "full")
  const full = describeToolForProfile({ name: "ues_code_edit", description: SAFETY_DESCRIPTION }, "full")
  assert.equal(full.description, SAFETY_DESCRIPTION)
  assert.equal(full.savedChars, 0)
  assert.equal(full.fellBack, false)
})

test("G2: every profile keeps the protective lines", () => {
  for (const profile of TOOL_DESCRIPTION_PROFILES) {
    const row = describeToolForProfile({ name: "ues_code_edit", description: SAFETY_DESCRIPTION }, profile)
    assert.ok(row.description.length <= PROFILE_LIMITS[profile].maxChars, `${profile} respects its bound`)
    assert.ok(/stale or mismatched anchor is rejected/i.test(row.description), `${profile} keeps the rejection rule`)
    assert.ok(/re-read with ues_code/i.test(row.description), `${profile} keeps the recovery instruction`)
    assert.equal(row.fellBack, false)
  }
})

test("G3: safety content is never truncated to hit a size target", () => {
  // A long safety block. The contract changed in V16.6: instead of char-slicing
  // the text and then throwing the whole result away because the slice cut a
  // safety line, the compressor drops non-protective units until it fits and
  // keeps the safety content unconditionally. If the SAFETY content alone
  // exceeds the bound, it is kept anyway and the overage is reported.
  const description = [
    "Bounded tool with a long introductory paragraph that explains the shape of the interface in detail.",
    "- ALWAYS verify permissions before writing anything to disk.",
    "- NEVER write outside the workspace containment boundary.",
    "- Every error is surfaced to the caller and never swallowed silently.",
    "- Secret material must never appear in the returned output payload.",
  ].join("\n")
  const safetyLines = description.split("\n").filter((line) => line.startsWith("- "))

  const fits = describeToolForProfile({ name: "ues_code_edit", description }, "minimal")
  assert.deepEqual(fits.droppedProtective, [], "no safety unit is ever dropped")
  for (const line of safetyLines) {
    assert.ok(fits.description.includes(line), `minimal keeps: ${line.slice(0, 40)}`)
  }
  assert.ok(fits.description.length <= PROFILE_LIMITS.minimal.maxChars, "it fits once the prose intro is dropped")
  assert.ok(!fits.description.includes("long introductory paragraph"), "non-safety prose is what got dropped")

  // Now a description whose SAFETY content alone cannot fit the bound.
  const safetyHeavy = [
    ...Array.from({ length: 8 }, (_, index) => `- NEVER write outside the workspace containment boundary number ${index}.`),
  ].join("\n")
  const heavy = describeToolForProfile({ name: "ues_code_edit", description: safetyHeavy }, "minimal")
  assert.equal(heavy.droppedProtective.length, 0, "safety content is still never dropped")
  assert.equal(heavy.fellBack, false, "no fall-back is needed when nothing was lost")
  assert.equal(heavy.overCharBudget, true, "the overage is reported rather than silently truncating safety text")
  assert.ok(heavy.chars > PROFILE_LIMITS.minimal.maxChars, "the safety text is kept whole")
  for (const line of safetyHeavy.split("\n")) {
    assert.ok(heavy.description.includes(line), "every safety line survives verbatim")
  }
})

test("G3b: the anchored-edit safety block survives even the minimal profile", () => {
  for (const profile of TOOL_DESCRIPTION_PROFILES) {
    const row = describeToolForProfile({ name: "ues_code_edit", description: SAFETY_DESCRIPTION }, profile)
    for (const line of SAFETY_DESCRIPTION.split("\n").slice(1)) {
      assert.ok(row.description.includes(line), `${profile} keeps: ${line.slice(0, 40)}`)
    }
  }
})

test("G4: the safety floor beats an env override", () => {
  const highRisk = resolveToolDescriptionProfile({ env: { UES_TOOL_DESCRIPTION_PROFILE: "minimal" }, risk: "high" })
  assert.equal(highRisk.profile, "full")
  assert.equal(highRisk.source, "safety-floor")
  const noisy = resolveToolDescriptionProfile({ env: { UES_TOOL_DESCRIPTION_PROFILE: "minimal" }, selectionErrors: 2 })
  assert.equal(noisy.profile, "full")
  const invalid = resolveToolDescriptionProfile({ env: { UES_TOOL_DESCRIPTION_PROFILE: "ludicrous" } })
  assert.equal(invalid.profile, "full")
  assert.equal(invalid.normalized, false, "an invalid value is reported, never silently accepted")
  const granted = resolveToolDescriptionProfile({ env: { UES_TOOL_DESCRIPTION_PROFILE: "compact" } })
  assert.equal(granted.profile, "compact")
})

test("G5: profiling a whole surface never invents a tool", () => {
  const surface = profileToolSurface([
    { name: "read", description: SAFETY_DESCRIPTION },
    { name: "write", description: SAFETY_DESCRIPTION },
  ], "minimal")
  assert.deepEqual(surface.tools.map((row) => row.name), ["read", "write"])
  assert.ok(surface.tools.every((row) => row.description.length > 0))
  assert.equal(surface.stats.toolCount.value, 2)
  assert.ok(surface.stats.originalChars.value >= surface.stats.visibleChars.value)
})

test("H1: CACHE mode forbids any prefix drift", () => {
  assert.equal(DRIFT_BUDGETS.CACHE.maxDrift, 0)
  const drift = guardPrefixDrift({ baseline: ["read", "grep", "edit", "write"], current: ["write", "grep", "edit", "read"], mode: "CACHE" })
  assert.equal(drift.ok, false)
  assert.ok(drift.violations.some((row) => String(row).startsWith("prefix-drift:")))
  const stable = guardPrefixDrift({ baseline: ["read", "grep"], current: ["read", "grep"], mode: "CACHE" })
  assert.equal(stable.ok, true)
})

test("H2: drift is report-only and never reorders anything", () => {
  const baseline = ["read", "grep", "edit", "write"]
  const current = ["read", "grep", "edit", "write", "bash"]
  const report = guardPrefixDrift({ baseline, current, mode: "TOKEN" })
  assert.equal(report.ok, true, "appending is not drift")
  assert.deepEqual(baseline, ["read", "grep", "edit", "write"], "the baseline is never mutated")
  assert.deepEqual(current, ["read", "grep", "edit", "write", "bash"], "the current order is never mutated")
  assert.equal(report.commonPrefix, 4)
})

test("H3: an env budget may only tighten, never loosen", () => {
  const loose = resolveDriftBudget({ UES_PREFIX_DRIFT_BUDGET: "99" }, "CACHE")
  assert.equal(loose.maxDrift, DRIFT_BUDGETS.CACHE.maxDrift)
  const tighter = resolveDriftBudget({ UES_PREFIX_DRIFT_BUDGET: "0" }, "TOKEN")
  assert.equal(tighter.maxDrift, 0)
  assert.ok(DRIFT_MODES.includes("CACHE"))
})

test("H4: fingerprints and prefix lengths are deterministic", () => {
  assert.equal(prefixFingerprint(["a", "b", "c"]), prefixFingerprint(["a", "b", "c"]))
  assert.notEqual(prefixFingerprint(["a", "b", "c"]), prefixFingerprint(["a", "b", "d"]))
  assert.equal(commonPrefixLength(["a", "b", "c"], ["a", "b", "d"]), 2)
})

test("I1: the observer header is the released one-line format", () => {
  assert.equal(observerHeaderV2({ reasoningMode: "deepseek-first", profile: "BALANCED" }), "UES 16.6 · DEEPSEEK-FIRST · BALANCED")
  assert.equal(observerHeaderV2({ reasoningMode: "balanced", profile: "FAST" }), "UES 16.6 · BALANCED · FAST")
})

test("I2: observer modes are bounded and invalid values are reported", () => {
  assert.deepEqual(PROGRESS_MODES, ["compact", "detailed", "off"])
  assert.equal(resolveProgressMode({}).mode, "compact")
  const invalid = resolveProgressMode({ UES_PROGRESS_OBSERVER_V2: "loud" })
  assert.equal(invalid.mode, "compact")
  assert.equal(invalid.normalized, false)
  const off = createProgressObserverV2({ mode: "off", profile: "FAST" })
  recordProgressV2(off, "x", { note: "y" })
  assert.equal(off.events.length, 0, "OFF emits nothing at all")
})

test("I3: notes are redacted and bounded, and lanes are capped", () => {
  const observer = createProgressObserverV2({ mode: "detailed", profile: "DEEP" })
  for (let i = 0; i < 20; i += 1) upsertLaneV2(observer, { id: `lane-${i}`, state: "running", action: `step ${i}` })
  assert.ok(observer.lanes.length <= 8)
  assert.ok(observer.dropped >= 1, "dropped lanes are counted, never silently kept")
  recordProgressV2(observer, "note", { note: `token sk-abcdef1234567890abcdef ${"x".repeat(400)}` })
  const event = observer.events.at(-1)
  assert.ok(event.note.length <= 160)
  assert.ok(!event.note.includes("sk-abcdef1234567890abcdef"))
  assert.ok(!/sk-abcdef/.test(sanitizeNote("token sk-abcdef1234567890abcdef")))
  assert.ok(!/hunter2hunter2/.test(sanitizeNote("password=hunter2hunter2")))
})

test("I4: observer telemetry is honest about secrets and chain-of-thought", () => {
  const observer = createProgressObserverV2({ mode: "detailed", profile: "DEEP", phase: "execute" })
  recordProgressV2(observer, "phase", { note: "api_key=sk-abcdef1234567890abcdef" })
  const telemetry = progressTelemetryV2(observer)
  // V16.6.1: `secretsEmitted` is now the result of a REAL post-render scan over
  // the exact lines the observer prints - not an asserted constant. The redaction
  // path means the scan finds nothing.
  assert.equal(telemetry.secretsEmitted.provenance, "MEASURED")
  assert.equal(telemetry.secretsEmitted.value, 0)
  assert.ok(telemetry.renderedLinesScanned.value >= 1)
  assert.deepEqual(telemetry.secretScanHits, [])
  // Chain of thought is a POLICY INVARIANT, not an empirical zero. Reporting it
  // as `measured(0)` claimed a measurement that never ran.
  assert.equal(telemetry.chainOfThoughtEmitted.provenance, "NOT_MEASURED")
  assert.equal(telemetry.chainOfThoughtEmitted.value, null)
  assert.equal(telemetry.chainOfThought.possible, false)
  assert.equal(telemetry.chainOfThought.basis, "policy-invariant")
  assert.ok(telemetry.redactions.value >= 1)
  assert.equal(renderProgressV2(observer)[0].startsWith("UES 16.6 ·"), true)
  assert.match(summarizeProgressV2(observer), /phase=execute/)
})

test("I4b: the observer secret scan really scans (a leak would be reported)", () => {
  // The scan is a function over the rendered lines, so it can be proven live
  // rather than asserted: feed it a real leak and it must be reported.
  const clean = observerSecretScan(["nothing sensitive here", "phase=execute"]);
  assert.equal(clean.hits.length, 0);
  assert.equal(clean.lines, 2);
  const leak = observerSecretScan(["token sk-abcdef1234567890abcdef"]);
  assert.equal(leak.hits.length, 1, "a real leak must be measured, not assumed away");
  assert.match(leak.hits[0], /sk-abcdef/);
})

test("J1: overlap requires read-only local work and exactly one DeepSeek writer", () => {
  const state = createParallelReasoningState()
  const ok = planParallelReasoning({
    budget: { deepSeekMode: "balanced", maxParallel: 2 },
    state,
    localWork: READ_ONLY_OPERATIONS.slice(0, 2).map((kind) => ({ kind })),
  })
  assert.equal(ok.overlapAllowed, true)
  assert.equal(ok.writer, "deepseek")
  assert.ok(ok.readers.length <= 1)
  const twoWriters = planParallelReasoning({
    budget: { deepSeekMode: "balanced", maxParallel: 3 },
    state: createParallelReasoningState(),
    deepSeekWriterInFlight: true,
    localWork: [{ kind: "grep" }],
  })
  assert.equal(twoWriters.overlapAllowed, false)
  assert.ok(twoWriters.reasons.includes("writer-already-in-flight"))
})

test("J2: any write during overlap is refused fail-closed", () => {
  for (const kind of ["write", "edit", "bash", "git-commit", "verify", "browser", "publish"]) {
    const plan = planParallelReasoning({
      budget: { deepSeekMode: "balanced", maxParallel: 3 },
      state: createParallelReasoningState(),
      localWork: [{ kind: "grep" }, { kind }],
    })
    assert.equal(plan.overlapAllowed, false, kind)
    assert.ok(plan.reasons.some((row) => String(row).includes(kind)), `${kind} is named in the refusal`)
  }
  assert.ok(FORBIDDEN_DURING_OVERLAP.includes("write"))
})

test("J3: a realized overlap with a forbidden operation is a violation", () => {
  const state = createParallelReasoningState()
  const plan = planParallelReasoning({
    budget: { deepSeekMode: "balanced", maxParallel: 2 },
    state,
    localWork: [{ kind: "grep" }],
  })
  const clean = guardOverlapWindow({ plan, state, operations: [{ kind: "grep" }], startedAt: 1_000, endedAt: 1_150 })
  assert.equal(clean.ok, true)
  const dirty = guardOverlapWindow({ plan, state, operations: [{ kind: "grep" }, { kind: "bash" }], startedAt: 1_000, endedAt: 1_150 })
  assert.equal(dirty.ok, false)
  assert.ok(dirty.violations.some((row) => String(row).includes("bash")))
})

test("J4: overlap telemetry measures only what it can measure", () => {
  const state = createParallelReasoningState()
  const plan = planParallelReasoning({
    budget: { deepSeekMode: "balanced", maxParallel: 2 },
    state,
    localWork: [{ kind: "grep" }],
  })
  guardOverlapWindow({ plan, state, operations: [{ kind: "grep" }], startedAt: 1_000, endedAt: 1_150, deepSeekWriters: 1 })
  const measured = parallelReasoningTelemetry(state)
  assert.equal(measured.overlapMs.provenance, "MEASURED")
  assert.equal(measured.overlapMs.value, 150)
  assert.equal(measured.overlapWindows.value, 1)
  assert.equal(measured.readOnlyOpsDuringOverlap.value, 1)
  assert.equal(measured.writersDuringOverlap.value, 1)
  assert.equal(measured.wallClockSaved.provenance, "NOT_MEASURED")
  assert.equal(measured.serialBaselineMs.provenance, "NOT_MEASURED")
  const unmeasured = parallelReasoningTelemetry(createParallelReasoningState())
  assert.equal(unmeasured.overlapMs.provenance, "NOT_MEASURED")
})

test("K1: known noise families are detected, and unique warnings are NOT noise", () => {
  const noisy = [
    "added 120 packages",
    "audited 121 packages in 400ms",
    "packages are looking for funding",
    "npm audit: no vulnerabilities found",
  ].join("\n")
  const families = detectNoiseFamilies(noisy)
  assert.ok(families.includes("dependency-install"), families.join(","))

  // V16.6.1: three DIFFERENT deprecation warnings are unique evidence. The
  // previous PRESERVE pattern let them through the noise path where the
  // consecutive-family collapse merged them into a single line, losing three
  // distinct package names.
  const uniqueDeprecations = [
    "npm WARN deprecated package@1.0.0",
    "npm WARN deprecated other@2.0.0",
    "npm WARN deprecated third@3.0.0",
    "npm ERR! code ELIFECYCLE",
  ].join("\n")
  const deprecationResult = compressRepetitiveOutput(uniqueDeprecations, { enabled: true })
  assert.equal(deprecationResult.compressed, false, "unique deprecation evidence is never collapsed")
  assert.equal(deprecationResult.text, uniqueDeprecations)
  assert.ok(deprecationResult.families.length === 0)
  // The `up to date` typo fix: npm's real line is now recognised.
  assert.ok(detectNoiseFamilies("up to date in 2s").includes("dependency-install"))
})

test("K2: compression is byte-identical when nothing qualifies", () => {
  const signal = ["error: TypeError: x is not a function", "at foo (bar.mjs:12:5)", "FAILED tests 3/12"].join("\n")
  const result = compressRepetitiveOutput(signal, { enabled: true })
  assert.equal(result.text, signal)
  assert.equal(result.compressed, false)
  const disabled = compressRepetitiveOutput(signal, { enabled: false })
  assert.equal(disabled.text, signal, "disabled means byte-identical")
})

test("K3: compression keeps every preserved line and is provably lossless", () => {
  const noisy = [
    // Genuinely no-signal repetition: the same progress shape over and over.
    ...Array.from({ length: 12 }, (_, index) => `[██████░░░░] ${index % 3 + 1}/12 resolving dependencies`),
    "src/lib/x.mjs:42:13 something broke",
    "npm ERR! code ELIFECYCLE",
    // Unique deprecation evidence interleaved with the noise.
    "npm WARN deprecated pkg-a@1.0.0",
    "npm WARN deprecated pkg-b@2.0.0",
  ].join("\n")
  const result = compressRepetitiveOutput(noisy, { enabled: true })
  const audit = assertNoLossyTransform(noisy, result.text)
  assert.equal(audit.ok, true, audit.violations.join("; "))
  assert.ok(result.text.includes("src/lib/x.mjs:42:13"), "the real error line survives")
  assert.ok(result.text.includes("npm ERR!"), "the failure line survives")
  assert.ok(result.text.includes("npm WARN deprecated pkg-a@1.0.0"), "unique deprecation evidence survives")
  assert.ok(result.text.includes("npm WARN deprecated pkg-b@2.0.0"), "a second unique deprecation survives")
  assert.ok(result.text.length < noisy.length, "compression must actually shrink the output")
})

test("K4: economy telemetry reports measured savings, not invented ones", () => {
  const noisy = Array.from({ length: 40 }, (_, index) => `[████████░░] ${index % 5 + 1}/40 installing packages`).join("\n")
  const result = compressRepetitiveOutput(noisy, { enabled: true })
  const telemetry = toolOutputEconomyTelemetry(result)
  assert.equal(telemetry.rawOutputChars.value, noisy.length)
  assert.equal(telemetry.visibleOutputChars.value, result.text.length)
  assert.equal(telemetry.savedChars.value, noisy.length - result.text.length)
  assert.ok(telemetry.runsCollapsed.value >= 1)
  assert.equal(telemetry.providerTokensSaved.provenance, "NOT_MEASURED", "no invented provider savings")
  assert.equal(telemetry.transformMs.provenance, "NOT_MEASURED")
  // V16.6.1: chars/4 is an ESTIMATE. Reporting it as DERIVED overstated it.
  assert.equal(telemetry.estimatedSavedTokens.provenance, "ESTIMATED")
  assert.equal(telemetry.savedChars.provenance, "DERIVED")
})

test("K5: the task telemetry v16_6 block is additive and provenance-labelled", () => {
  const budget = computeOrchestrationBudget({ taskPolicy: { risk: "low" }, affectedFiles: 3 })
  const withBudget = buildTaskTelemetry({ agent: "ues-executor", exitCode: 0 }, { v16_6Budget: budget })
  assert.equal(withBudget.v16_6.release, "v16.6")
  assert.equal(withBudget.v16_6.executionProfile, budget.executionProfile)
  assert.ok("wallTimeMs" in withBudget.metrics, "existing metric fields keep their shape")
  assert.equal(withBudget.metrics.toolCalls, 0)
  assert.equal(withBudget.schemaVersion, 2, "the telemetry schema version is unchanged")
  const withoutBudget = buildTaskTelemetry({}, {})
  assert.equal(withoutBudget.v16_6, null, "no budget means no invented block")
  const deepSeek = buildTaskTelemetry({}, {
    v16_6Budget: budget,
    deepSeek: { turnsUsed: 1, consultations: 1, followUps: 0, cacheHits: 0, cacheMisses: 1, rotations: 0, refusals: [] },
  })
  assert.equal(deepSeek.v16_6.deepSeek.tokensSaved.provenance, "NOT_MEASURED")
  assert.equal(deepSeek.v16_6.deepSeek.latencySavedMs.provenance, "NOT_MEASURED")
  assert.ok(Array.isArray(deepSeek.v16_6.reasons))
})