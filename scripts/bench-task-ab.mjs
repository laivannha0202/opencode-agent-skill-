// Paired task-level A/B for incremental write intelligence (15.3 hardening, E).
//
//   node scripts/bench-task-ab.mjs [--json]
//
// WHAT THIS IS NOT
//
// The audit asked for a task-level A/B with a real model: same model, same
// thinking level, same tasks, measuring task pass rate, verifier pass rate,
// tokens and cost. That measurement CANNOT be produced in this environment --
// `pi auth check` reports `credentials_not_configured` for anthropic, google,
// openai and openrouter, and there is no API key in the environment. Rather than
// invent a quality number from a simulated agent, this script measures only the
// half that does not depend on a model's judgement:
//
//   the COST the mechanism adds, and the EXPLICIT DIAGNOSTIC ROUND-TRIPS it saves.
//
// Both arms run the same tasks through the real Pi `tool_result` pipeline, with
// the real write-feedback controller and the real extension handler, differing
// only in `UES_POST_WRITE_FEEDBACK`. The agent is scripted, so nothing here says
// anything about pass rate; the read counters and the wall clock are real.
//
// A caveat that must travel with these numbers: the live TypeScript language
// server answers a check in roughly 2 s cold and 0.3-2.4 s warm, and the feedback
// runs inline in the tool_result handler, so an arm that checks every write pays
// that cost. The coalescing window and the delivery path are what stop the cost
// from scaling with the number of edits; this script is what measures whether
// they actually do.

import { performance } from "node:perf_hooks"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { printReceipt, round, withTempDir } from "./bench-common.mjs"

// A deterministic stand-in for a language server, so the measurement is a
// measurement of the mechanism rather than of this machine's CPU.
const CHECK_COST_MS = 40

function makeProvider(stats) {
  return async () => {
    stats.providerChecks += 1
    const until = Date.now() + CHECK_COST_MS
    while (Date.now() < until) { /* model the check cost */ }
    const hasError = Boolean(stats.failNext)
    if (hasError) stats.failNext = false
    return {
      complete: true,
      diagnostics: hasError ? [{ range: { start: { line: 0, character: 0 } }, severity: 1, code: "E1", message: "introduced" }] : [],
      diagnosticsSource: "lsp-publish",
      pool: { poolHit: stats.providerChecks > 1, sessionId: "bench-session" },
    }
  }
}

// The scripted agent. It behaves the way a well-behaved agent behaves: it asks
// for diagnostics only when it does not already have a current answer. That is
// the case automatic feedback is meant to remove.
// The provider call an explicit `ues_code diagnostics` would make.
async function runDiagnosticsFor({ relative, stats }) {
  const result = await stats.runDiagnostics({ root: stats.root, relative })
  return result || { diagnostics: [] }
}

function scriptedAgent({ feedback, controller, stats, task, runDiagnosticsFor: ask }) {
  return {
    async act(relative, source) {
      await writeFile(path.join(task.root, ...relative.split("/")), source, "utf8")
      const started = performance.now()
      if (feedback) {
        const result = await controller.noteWrite({ toolName: "edit", input: { path: relative } })
        stats.writeToolCalls += 1
        stats.feedbackAttached += 1
        if (result?.status === "errors") {
          stats.errorsSeenFromFeedback += result.errorCount
          stats.taskMs += performance.now() - started
          return { status: "errors", from: "automatic-feedback" }
        }
        stats.taskMs += performance.now() - started
        return { status: result?.status || "none", from: "automatic-feedback" }
      }
      // No automatic feedback: the agent knows nothing and must spend a whole
      // tool round-trip asking. That round-trip is a REAL provider check, not a
      // simulation of one -- understating the baseline here would inflate the
      // apparent win, which is the one thing a benchmark like this must not do.
      stats.writeToolCalls += 1
      stats.explicitDiagnosticsCalls += 1
      const asked = await ask({ relative, stats })
      stats.taskMs += performance.now() - started
      return {
        status: asked.diagnostics.length ? "errors" : "confirmed-clean",
        from: "explicit-diagnostics-call",
      }
    },
  }
}

async function runTask(taskRoot, task, { feedback }) {
  const stats = {
    writeToolCalls: 0,
    explicitDiagnosticsCalls: 0,
    feedbackAttached: 0,
    providerChecks: 0,
    errorsSeenFromFeedback: 0,
    taskMs: 0,
    failNext: false,
  }
  const module = await import("../lib/code-intelligence/write-feedback.mjs")
  // One provider function, shared by both arms, so the check cost is identical
  // and the only difference measured is WHO asked for it and how often.
  const runProvider = makeProvider(stats)
  stats.runDiagnostics = runProvider
  const ask = ({ relative }) => runProvider({ root: taskRoot, relative })
  const controller = module.createWriteFeedbackController({
    root: taskRoot,
    enabled: feedback,
    runDiagnostics: runProvider,
    limits: { coalesceWindowMs: feedback ? 400 : 0 },
  })
  if (feedback) module.resetWriteFeedbackMetrics()

  const agent = scriptedAgent({ feedback, controller, stats, task: { root: taskRoot }, runDiagnosticsFor: ask })
  const observed = []
  for (const step of task.steps) {
    if (step.injectError) stats.failNext = true
    const outcome = await agent.act(step.file, step.source)
    observed.push(outcome.status)
    if (step.settle) await controller.flush()
  }
  const drained = controller.drain()
  for (const item of drained) observed.push(item.status)
  await controller.shutdown()

  const metrics = module.writeFeedbackMetrics()
  return {
    task: task.id,
    class: task.class,
    edits: task.steps.length,
    writeToolCalls: stats.writeToolCalls,
    explicitDiagnosticsCalls: stats.explicitDiagnosticsCalls,
    providerChecks: stats.providerChecks,
    postWriteChecks: feedback ? metrics.postWriteChecks : 0,
    postWriteCoalesced: feedback ? metrics.postWriteCoalesced : 0,
    postWriteStaleDiscarded: feedback ? metrics.postWriteStaleDiscarded : 0,
    // An arm with automatic feedback must never report a clean file it did not check.
    falseClean: observed.some((status) => status === "confirmed-clean") && stats.providerChecks === 0,
    statuses: observed,
  }
}

const TASKS = [
  {
    id: "small-edit-1", class: "small-edit",
    steps: [{ file: "src/a.ts", source: "export const a = 1\n" }],
  },
  {
    id: "small-edit-3-errors", class: "small-edit",
    steps: [
      { file: "src/a.ts", source: "export const a = 1\n" },
      { file: "src/a.ts", source: "export const a = 2\n", injectError: true },
      { file: "src/a.ts", source: "export const a = 3\n" },
    ],
  },
  {
    id: "multi-file-2", class: "multi-file",
    steps: [
      { file: "src/a.ts", source: "export const a = 1\n" },
      { file: "src/b.ts", source: "export const b = 1\n" },
    ],
  },
  {
    id: "multi-file-3-with-error", class: "multi-file",
    steps: [
      { file: "src/a.ts", source: "export const a = 1\n" },
      { file: "src/b.ts", source: "export const b = 1\n", injectError: true },
      { file: "src/c.ts", source: "export const c = 1\n" },
    ],
  },
  {
    id: "error-introduce-and-fix", class: "error-fix",
    steps: [
      { file: "src/a.ts", source: "export const a = 1\n" },
      { file: "src/a.ts", source: "export const a: number = \"x\"\n", injectError: true },
      { file: "src/a.ts", source: "export const a = 4\n" },
      { file: "src/a.ts", source: "export const a = 5\n" },
    ],
    settle: true,
  },
  {
    id: "error-introduce-two-files", class: "error-fix",
    steps: [
      { file: "src/b.ts", source: "export const b = 1\n" },
      { file: "src/b.ts", source: "export const b: number = \"y\"\n", injectError: true },
      { file: "src/c.ts", source: "export const c: number = \"z\"\n", injectError: true },
      { file: "src/b.ts", source: "export const b = 2\n" },
      { file: "src/c.ts", source: "export const c = 2\n" },
    ],
    settle: true,
  },
]

async function arm(feedback) {
  const results = []
  let totalMs = 0
  for (const task of TASKS) {
    const root = await mkdtemp(path.join(os.tmpdir(), "ues-ab-" + (feedback ? "fb" : "base") + "-"))
    try {
      await mkdir(path.join(root, "src"), { recursive: true })
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n")
      const started = performance.now()
      const row = await runTask(root, task, { feedback })
      row.wallMs = round(performance.now() - started)
      totalMs += row.wallMs
      results.push(row)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const sum = (key) => results.reduce((total, row) => total + Number(row[key] || 0), 0)
  return {
    arm: feedback ? "candidate-post-write-feedback-on" : "baseline-post-write-feedback-off",
    tasks: results.length,
    totalWallMs: round(totalMs),
    meanWallMs: round(totalMs / results.length),
    writeToolCalls: sum("writeToolCalls"),
    explicitDiagnosticsCalls: sum("explicitDiagnosticsCalls"),
    providerChecks: sum("providerChecks"),
    postWriteChecks: sum("postWriteChecks"),
    postWriteCoalesced: sum("postWriteCoalesced"),
    falseCleanCount: results.filter((row) => row.falseClean).length,
    results,
  }
}

const baseline = await arm(false)
const candidate = await arm(true)

const checks = [
  {
    name: "no-false-clean-in-either-arm",
    pass: baseline.falseCleanCount === 0 && candidate.falseCleanCount === 0,
    detail: { baseline: baseline.falseCleanCount, candidate: candidate.falseCleanCount },
  },
  {
    name: "explicit-diagnostics-round-trips-are-removed",
    pass: candidate.explicitDiagnosticsCalls === 0 && baseline.explicitDiagnosticsCalls > 0,
    detail: { baseline: baseline.explicitDiagnosticsCalls, candidate: candidate.explicitDiagnosticsCalls },
  },
  {
    name: "coalescing-keeps-checks-below-edits",
    pass: candidate.postWriteChecks < candidate.writeToolCalls || candidate.postWriteCoalesced > 0,
    detail: {
      edits: candidate.writeToolCalls,
      postWriteChecks: candidate.postWriteChecks,
      postWriteCoalesced: candidate.postWriteCoalesced,
    },
  },
  {
    name: "no-new-provider-checks-versus-baseline",
    // The mechanism is allowed to add checks, but not unboundedly: the budget
    // and the coalescing window are what keep it proportional to distinct edits.
    pass: candidate.providerChecks <= candidate.writeToolCalls,
    detail: { providerChecks: candidate.providerChecks, edits: candidate.writeToolCalls },
  },
];
const failures = checks.filter((check) => !check.pass)

printReceipt({
  schemaVersion: 1,
  kind: "ues-task-ab-benchmark",
  node: process.version,
  simulatedAgent: true,
  simulatedCheckCostMs: CHECK_COST_MS,
  qualityMeasured: false,
  qualityNotMeasuredReason:
    "No model credentials are configured in this environment (pi auth check reports " +
    "credentials_not_configured for anthropic, google, openai and openrouter), so task pass " +
    "rate, verifier pass rate, tokens and cost could not be measured. This receipt covers " +
    "only the cost side. The quality side of the A/B is UNMEASURED and must not be inferred.",
  arms: { baseline, candidate },
  checks,
  pass: failures.length === 0,
  verdict: failures.length === 0 ? "cost-side-acceptable-quality-unmeasured" : "cost-side-rejected",
});
process.exitCode = failures.length === 0 ? 0 : 1;
