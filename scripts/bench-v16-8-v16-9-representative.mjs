// V16.9 REPRESENTATIVE V16.8-vs-V16.9 BENCHMARK (classes A-G).
//
// WHY THIS EXISTS
//
// The only V16.9 benchmark shipped so far (`bench-v16-9-admission.mjs`) measures
// ONE synthetic no-signal task. That is a no-signal microbenchmark, and the
// release directive explicitly forbids extrapolating its result into a total
// task speedup. This script measures a REPRESENTATIVE SET of task classes end
// to end through the REAL production lanes:
//
//   A  trivial deterministic          (admission -> LOCAL, no provider)
//   B  normal Pi-only                 (admission -> PI_ONLY, no provider)
//   C  complex advisor one-turn       (admission -> PI_PLUS_ADVISOR, one consult)
//   D  advisor evidence-request       (two turns: consult + served evidence)
//   E  verifier-fail + correction     (consult + one bounded follow-up)
//   F  warm browser repeated task     (same lane, repeated consult)
//   G  cold browser first task        (fresh lane, first consult)
//
// MEASUREMENT DISCIPLINE
//
//   * Wall-clock ms, char counts and call counts are MEASURED.
//   * Provider TOKEN usage is NOT_MEASURED: no real telemetry is available in a
//     deterministic double, and chars->tokens is an ESTIMATE at best.
//   * Nothing here is extrapolated into a total speedup.
//
// Run: node scripts/bench-v16-8-v16-9-representative.mjs

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createWebReasoningLane as createV16_8Lane } from "../lib/web-reasoning-lane-v16-8.mjs"
import { createWebReasoningLane as createV16_9Lane } from "../lib/web-reasoning-lane-v16-9.mjs"
import { createEvidenceBroker } from "../lib/evidence-broker.mjs"
import { createSharedContextLedger } from "../lib/shared-context-ledger.mjs"

const ADVICE = {
  summary: "The source contract is inconsistent with the current consumer.",
  hypotheses: ["A narrow contract mismatch is the root cause."],
  recommendedApproach: ["Update the existing contract once.", "Keep the edit scoped to the grounded file."],
  filesToInspect: ["src/core.mjs"],
  risks: ["Do not widen the edit."],
  edgeCases: [],
  verificationSuggestions: ["Run the focused core test."],
  confidence: 0.9,
}

const ADVICE_WITH_REQUEST = {
  ...ADVICE,
  evidenceRequests: [{ kind: "diff", reason: "Need the exact patch under review." }],
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-rep-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Bench"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function adapter(script = {}) {
  const calls = { startSession: 0, consult: 0, followUp: 0 }
  return {
    calls,
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => { calls.startSession += 1; return { sessionId: "bench", state: "ready" } },
    consult: async () => { calls.consult += 1; return { answer: JSON.stringify(script.consult || ADVICE), latencyMs: 1 } },
    followUp: async () => { calls.followUp += 1; return { answer: JSON.stringify(script.followUp || ADVICE), latencyMs: 1 } },
    closeSession: async () => true,
  }
}

const NO_SIGNAL_TASK = {
  task: "Rename the local variable `value` to `amount` in one file.",
  notes: [],
  affectedSubsystems: 0,
  relevantFiles: [],
  evidence: [],
}

const DETERMINISTIC_TASK = {
  // The TEXT contains an escalation signal ("root cause"), so V16.8's
  // escalation router WOULD consult. V16.9's admission sees the DECLARED
  // deterministic proof and routes LOCAL without a provider. This is the honest
  // demonstration of the pre-gate: same input, same mode.
  task: "Fix the exact syntax error in src/core.mjs; the root cause is known.",
  notes: [],
  deterministicProven: true,
  relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded" }],
}

const ADVISOR_TASK = (root) => ({
  task: "The verifier still fails and the root cause is ambiguous across this contract.",
  workspaceRoot: root,
  knownFiles: ["src/core.mjs"],
  relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded target" }],
  evidence: [{ kind: "verifier", source: "bench", text: "contract mismatch" }],
  affectedSubsystems: 2,
})

function newLane(create, root, opts = {}) {
  return create({
    mode: opts.mode || "auto",
    provider: "deepseek-web",
    adapters: [adapter(opts.script)],
    workspaceRoot: root,
    maxConsultations: 1,
    maxFollowUps: 1,
    softDeadlineMs: 3_000,
    hardDeadlineMs: 6_000,
    ...opts.lane,
  })
}

/** Measure one async operation, returning ms + the result. */
async function timed(fn) {
  const t0 = process.hrtime.bigint()
  const value = await fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { ms, value }
}

function chars(...values) {
  return values.reduce((sum, v) => sum + String(v || "").length, 0)
}

const results = []

// --- Class A: trivial deterministic (V16.8 has no admission pre-gate) --------
{
  const root = fixture()
  try {
    // SAME mode (auto), SAME input. V16.8 escalates on the text signal; V16.9
    // sees `deterministicProven` and routes LOCAL before any provider work.
    const v168 = newLane(createV16_8Lane, root, { mode: "auto" })
    const a = await timed(() => v168.consult({ ...DETERMINISTIC_TASK, workspaceRoot: root }))
    const v169 = newLane(createV16_9Lane, root, { mode: "auto" })
    const b = await timed(() => v169.consult({ ...DETERMINISTIC_TASK, workspaceRoot: root }))
    results.push({
      class: "A-trivial-deterministic",
      v168: { wallMs: a.ms, outcome: a.value.outcome },
      v169: { wallMs: b.ms, outcome: b.value.outcome, admissionRoute: b.value.v16_9?.admission?.route || null },
      note: "V16.9 admission routes LOCAL on the deterministic proof without a provider; V16.8 escalates on the text signal.",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class B: normal Pi-only ------------------------------------------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "auto" })
    const a = await timed(() => v168.consult({ ...NO_SIGNAL_TASK, workspaceRoot: root }))
    const v169 = newLane(createV16_9Lane, root, { mode: "auto" })
    const b = await timed(() => v169.consult({ ...NO_SIGNAL_TASK, workspaceRoot: root }))
    results.push({
      class: "B-normal-pi-only",
      v168: { wallMs: a.ms, outcome: a.value.outcome, reason: a.value.reason },
      v169: { wallMs: b.ms, outcome: b.value.outcome, admissionRoute: b.value.v16_9?.admission?.route || null },
      note: "both skip the provider; V16.9 attributes the skip to admission.",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class C: complex advisor one-turn --------------------------------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "force" })
    const a = await timed(() => v168.consult(ADVISOR_TASK(root)))
    const v169 = newLane(createV16_9Lane, root, { mode: "force" })
    const b = await timed(() => v169.consult(ADVISOR_TASK(root)))
    results.push({
      class: "C-complex-advisor-one-turn",
      v168: {
        wallMs: a.ms,
        outcome: a.value.outcome,
        deepseekPromptChars: Number(a.value.packet?.chars || 0),
        deepseekResponseChars: chars(a.value.advice && JSON.stringify(a.value.advice)),
        piModelVisibleChars: chars(a.value.advisorText),
      },
      v169: {
        wallMs: b.ms,
        outcome: b.value.outcome,
        admissionRoute: b.value.v16_9?.admission?.route || null,
        deepseekPromptChars: Number(b.value.packet?.chars || 0),
        deepseekResponseChars: chars(b.value.advice && JSON.stringify(b.value.advice)),
        piModelVisibleChars: chars(b.value.advisorText),
        handoffStatus: b.value.v16_9?.handoff?.status || null,
      },
      note: "one consult each; V16.9 adds the write-side fence + handoff.",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class D: advisor evidence-request (two turns) --------------------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "force", script: { consult: ADVICE_WITH_REQUEST } })
    const a = await timed(() => v168.consult(ADVISOR_TASK(root)))
    const v169 = newLane(createV16_9Lane, root, { mode: "force", script: { consult: ADVICE_WITH_REQUEST } })
    const b = await timed(() => v169.consult(ADVISOR_TASK(root)))
    // Serve the request through the production broker + ledger.
    const ledger = createSharedContextLedger({ scope: `evidence:bench-d:${root}` })
    ledger.reset()
    // A realistic (large) diff so the `evidence_id` marker is genuinely smaller
    // than the bytes it replaces.
    const bigDiff = Array.from({ length: 240 }, (_, i) => `+export const row${i} = ${i}`).join("\n")
    const broker = createEvidenceBroker({ runId: "bench-d", root, ledger, sources: { diff: () => bigDiff } })
    const served = broker.serve(JSON.stringify({ evidenceRequests: ADVICE_WITH_REQUEST.evidenceRequests }), {})
    const servedAgain = broker.serve(JSON.stringify({ evidenceRequests: ADVICE_WITH_REQUEST.evidenceRequests }), {})
    results.push({
      class: "D-advisor-evidence-request",
      v168: { wallMs: a.ms, outcome: a.value.outcome, deepseekPromptChars: Number(a.value.packet?.chars || 0) },
      v169: {
        wallMs: b.ms,
        outcome: b.value.outcome,
        admissionRoute: b.value.v16_9?.admission?.route || null,
        deepseekPromptChars: Number(b.value.packet?.chars || 0),
        evidenceServedChars: served.deltaText.length,
        repeatedEvidenceChars: servedAgain.deltaText.length,
        evidenceResentCount: served.receipt.evidenceResent,
        evidenceReusedCount: servedAgain.receipt.evidenceReused,
      },
      note: "V16.9's ledger delivers the same request once, then an evidence_id marker.",
    })
    ledger.reset()
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class E: verifier-fail + advisor correction (follow-up) ----------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "force" })
    const a1 = await timed(() => v168.consult(ADVISOR_TASK(root)))
    const a2 = await timed(() => v168.followUp({ ...ADVISOR_TASK(root), diff: "export const value = 2", requestId: "bench-e-2" }))
    const v169 = newLane(createV16_9Lane, root, { mode: "force" })
    const b1 = await timed(() => v169.consult(ADVISOR_TASK(root)))
    const b2 = await timed(() => v169.followUp({ ...ADVISOR_TASK(root), diff: "export const value = 2", requestId: "bench-e-2" }))
    results.push({
      class: "E-verifier-fail-correction",
      v168: { wallMs: a1.ms + a2.ms, consultOutcome: a1.value.outcome, followUpOutcome: a2.value.outcome, followUpDeltaChars: Number(a2.value.delta?.chars || 0) },
      v169: { wallMs: b1.ms + b2.ms, consultOutcome: b1.value.outcome, followUpOutcome: b2.value.outcome, followUpDeltaChars: Number(b2.value.delta?.chars || 0) },
      note: "one bounded correction turn in the SAME conversation.",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class F: warm browser repeated task ------------------------------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "force" })
    await v168.consult(ADVISOR_TASK(root))
    const warm168 = []
    for (let i = 0; i < 5; i += 1) warm168.push((await timed(() => v168.followUp({ ...ADVISOR_TASK(root), diff: `export const value = ${i + 2}`, requestId: `warm168-${i}` }))).ms)
    const v169 = newLane(createV16_9Lane, root, { mode: "force" })
    await v169.consult(ADVISOR_TASK(root))
    const warm169 = []
    for (let i = 0; i < 5; i += 1) warm169.push((await timed(() => v169.followUp({ ...ADVISOR_TASK(root), diff: `export const value = ${i + 2}`, requestId: `warm169-${i}` }))).ms)
    const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]
    results.push({
      class: "F-warm-repeated-task",
      v168: { warmAcquireMsMedian: median(warm168), samples: warm168.length },
      v169: { warmAcquireMsMedian: median(warm169), samples: warm169.length },
      note: "a retained, healthy session is reused; no respawn between turns (both lanes).",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- Class G: cold browser first task ---------------------------------------
{
  const root = fixture()
  try {
    const v168 = newLane(createV16_8Lane, root, { mode: "force" })
    const a = await timed(() => v168.consult(ADVISOR_TASK(root)))
    const v169 = newLane(createV16_9Lane, root, { mode: "force" })
    const b = await timed(() => v169.consult(ADVISOR_TASK(root)))
    results.push({
      class: "G-cold-first-task",
      v168: { wallMs: a.ms },
      v169: { wallMs: b.ms },
      note: "cold lane creation + first consult (deterministic double; no real browser).",
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
const report = {
  schemaVersion: 1,
  kind: "ues-v16-9-representative-benchmark",
  provenance: {
    wallMs: "MEASURED",
    charCounts: "MEASURED",
    providerTokens: "NOT_MEASURED",
    note: "deterministic provider double: no real browser, no real provider token telemetry",
  },
  classes: results,
}
console.log(JSON.stringify(report, null, 2))
