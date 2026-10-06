#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createWebReasoningLane as createV16_7Lane } from "../lib/web-reasoning-lane.mjs"
import { createWebReasoningLane as createV16_8Lane } from "../lib/web-reasoning-lane-v16-8.mjs"
import { startReadOnlyLocalPrep } from "../lib/web-decision-barrier-v16-8.mjs"

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function median(values) {
  return percentile(values, 50)
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-8-bench-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Bench"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  mkdirSync(path.join(root, "test"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  for (let i = 0; i < 40; i += 1) {
    writeFileSync(path.join(root, "test", `core-${i}.test.mjs`), `import '../src/core.mjs'\nexport const n = ${i}\n`)
  }
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function deterministicAdapter(delayMs) {
  return {
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => ({ sessionId: "bench", state: "ready" }),
    consult: async () => {
      await sleep(delayMs)
      return { answer: JSON.stringify(ADVICE), latencyMs: delayMs }
    },
    followUp: async () => ({ answer: JSON.stringify(ADVICE), latencyMs: 1 }),
    closeSession: async () => true,
  }
}

function consultInput(root) {
  return {
    task: "The verifier still fails and the root cause is ambiguous across this contract.",
    workspaceRoot: root,
    knownFiles: ["src/core.mjs"],
    relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded target" }],
    evidence: [{ kind: "verifier", source: "bench", text: "contract mismatch" }],
    affectedSubsystems: 2,
    requestId: "bench-request",
  }
}

async function sequentialEquivalent(root, advisorDelayMs) {
  const input = consultInput(root)
  const lane = createV16_7Lane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [deterministicAdapter(advisorDelayMs)],
  })
  const started = performance.now()
  const result = await lane.consult(input)
  const advisorDone = performance.now()
  const prep = startReadOnlyLocalPrep(input, { workspaceRoot: root })
  await prep.critical
  await prep.optional
  const finished = performance.now()
  await lane.close()
  return {
    totalMs: finished - started,
    advisorMs: advisorDone - started,
    localPrepMs: finished - advisorDone,
    modelVisibleChars: String(result.advisorText || "").length,
  }
}

async function overlapped(root, advisorDelayMs) {
  const input = consultInput(root)
  const lane = createV16_8Lane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [deterministicAdapter(advisorDelayMs)],
    workspaceRoot: root,
    softDeadlineMs: Math.max(250, advisorDelayMs * 3),
    hardDeadlineMs: Math.max(1_000, advisorDelayMs * 6),
  })
  const started = performance.now()
  const result = await lane.consult(input)
  const finished = performance.now()
  await lane.close()
  return {
    totalMs: finished - started,
    advisorMs: Number(result.v16_8?.overlapTelemetry?.advisor_ms || 0),
    localPrepMs: Number(result.v16_8?.overlapTelemetry?.local_prep_ms || 0),
    overlapMs: Number(result.v16_8?.overlapTelemetry?.overlap_ms || 0),
    barrierWaitMs: Number(result.v16_8?.overlapTelemetry?.barrier_wait_ms || 0),
    modelVisibleChars: String(result.advisorText || "").length,
    modelVisibleCharsSaved: Number(result.v16_8?.overlapTelemetry?.model_visible_chars_saved || 0),
    outcome: result.outcome,
  }
}

const trials = Math.max(3, Math.min(15, Number(process.argv.find((arg) => arg.startsWith("--trials="))?.split("=")[1] || 7)))
const advisorDelayMs = Math.max(20, Math.min(2_000, Number(process.argv.find((arg) => arg.startsWith("--advisor-ms="))?.split("=")[1] || 180)))
const root = fixture()
try {
  const sequential = []
  const overlap = []
  for (let i = 0; i < trials; i += 1) {
    sequential.push(await sequentialEquivalent(root, advisorDelayMs))
    overlap.push(await overlapped(root, advisorDelayMs))
  }

  const sequentialTotals = sequential.map((row) => row.totalMs)
  const overlapTotals = overlap.map((row) => row.totalMs)
  const report = {
    schemaVersion: 1,
    kind: "ues-v16-8-overlap-benchmark",
    mode: "deterministic-double",
    note: "Sequential-equivalent vs overlapped execution of the SAME advisor delay + static local-prep work. This is not a live model speed claim.",
    trials,
    advisorDelayMs,
    cold: {
      sequential_ms: Number(sequential[0].totalMs.toFixed(2)),
      overlapped_ms: Number(overlap[0].totalMs.toFixed(2)),
      overlap_ms: Number(overlap[0].overlapMs.toFixed(2)),
    },
    warm: {
      sequential_median_ms: Number(median(sequentialTotals.slice(1)).toFixed(2)),
      sequential_p95_ms: Number(percentile(sequentialTotals.slice(1), 95).toFixed(2)),
      overlapped_median_ms: Number(median(overlapTotals.slice(1)).toFixed(2)),
      overlapped_p95_ms: Number(percentile(overlapTotals.slice(1), 95).toFixed(2)),
      measured_overlap_median_ms: Number(median(overlap.slice(1).map((row) => row.overlapMs)).toFixed(2)),
      barrier_wait_median_ms: Number(median(overlap.slice(1).map((row) => row.barrierWaitMs)).toFixed(2)),
    },
    modelFacing: {
      v16_7_advisor_chars_median: median(sequential.map((row) => row.modelVisibleChars)),
      v16_8_capsule_chars_median: median(overlap.map((row) => row.modelVisibleChars)),
      measured_chars_saved_median: median(overlap.map((row) => row.modelVisibleCharsSaved)),
      estimated_input_tokens_saved: null,
      provider_tokens_saved: null,
      provider_tokens_provenance: "NOT_MEASURED",
    },
    correctness: {
      advised_results: overlap.filter((row) => row.outcome === "advised").length,
      expected_advised_results: trials,
      tests_executed_during_overlap: 0,
      source_mutation_by_overlap_prep: false,
    },
    provenance: {
      timings: "MEASURED",
      model_visible_chars: "MEASURED",
      token_savings: "NOT_MEASURED",
      live_provider: "NOT_MEASURED",
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.correctness.advised_results !== trials) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
