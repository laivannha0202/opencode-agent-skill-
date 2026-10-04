#!/usr/bin/env node

// V16.3 real-task A/B benchmark harness.
//
//   A. Pi/UES local-only            (executorKind=deterministic-fixture)
//   B. Pi/UES + DeepSeek Web AUTO   (live provider or deterministic double)
//
// WHAT THIS IS. A harness that RUNS both arms over the same task set through the
// real V16.3 code (the real escalation router, the real packet builder, the real
// browser executor, and --live the real production DeepSeek adapter) and reports
// the numbers it measured.
//
// WHAT THIS IS NOT. A claim. There is no pre-baked percentage improvement
// anywhere in this file, there is no score that is asserted by construction, and
// no default that manufactures a quality number. Every quality field is either
// MEASURED from the arm's own verifier run or reported as `null` with an
// explicit reason. An arm that could not be measured says so; it does not get a
// favourable default.
//
// The deterministic local solver is a PIPELINE fixture, not a model. Arm A is
// labelled `executorKind=deterministic-fixture` and must never be presented as
// evidence that a weak Pi model became better or faster. A real model A/B uses
// `--executor=pi` with imported paired measured run receipts.
//
// Arms:
//   --arm=local   (default) run both arms over the task set
//   --arm=A|B     run a single arm
//   --repeat=N    paired repetitions per task (default 3)
//   --tasks=FILE  JSON task set; defaults to the built-in deterministic set
//   --live        require a real DeepSeek session via the production live worker
//                 plan (persistent profile). Requires explicit benchmark consent.
//   --yes-i-have-authorized-a-live-benchmark
//                 second guard: --live may submit MULTIPLE messages. Without it
//                 the live benchmark is SKIPPED with 0 submits.
//   --profile=NAME persistent profile name for --live (default deepseek-web)
//   --executor=deterministic-fixture|pi
//                 pi consumes paired measured receipts via --pi-receipts=FILE.
//   --pi-receipts=FILE paired measured Pi run receipts for --executor=pi
//   --pi-telemetry=FILE measured Pi/API token telemetry import (never estimated)
//   --answer-timeout-ms=N answer wait bound for the live adapter
//   --max-packet-chars=N decision packet bound
//   --json        machine-readable output
//
// Safety: benchmark tasks run against an isolated temporary fixture workspace,
// never destructively against the main working tree. The workspace is removed
// afterwards. No auth bypass, no secrets/.env content, rejected advice never
// becomes executor authority, DeepSeek never produces a PASS verdict, and the
// local verifier remains the final authority.

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile as readFileImpl, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import { buildDecisionPacket, buildFollowUpDelta, clearDecisionPacketCache } from "../lib/decision-packet.mjs"
import { createDeepSeekWebAdapter } from "../lib/deepseek-web-adapter.mjs"
import { preflightBrowserCapability } from "../lib/browser-capability.mjs"
import { createBrowserTelemetry } from "../lib/browser-evidence.mjs"
import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import { createWebReasoningTelemetry, runWebConsultation, runWebFollowUp } from "../lib/web-reasoning-escalation.mjs"
import { createBrowserWorkerClient, spawnBrowserWorkerTransport } from "../lib/browser-worker-client.mjs"
import { AUTH_PROBE_STATE, DEEPSEEK_PROFILE_NAME, waitForAuthenticatedPage } from "../lib/browser-profile.mjs"
import { WORKER_PROFILE_MODE, workerModePlan, workerModeViolation } from "../lib/browser-worker-mode.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workerScript = path.join(root, "scripts", "browser-worker-v16-3.mjs")
const ENTRY_URL = "https://chat.deepseek.com/"

const BENCH_TOOLS = [
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_navigate",
]

const BENCH_ANSWER_SELECTORS = [
  "[data-message-role='assistant']",
  ".ds-markdown",
  "[class*='assistant']",
]

// The built-in task set is a FIXTURE, and it is labelled as one. Each task
// declares what a correct local fix looks like so `verifiedPass` is a real
// check against local evidence, not a self-assessment.
const DEFAULT_TASKS = [
  {
    id: "v163-ambiguous-mcp-retry",
    prompt: "The verifier still fails across the browser execution and MCP health modules; the root cause is ambiguous and several fixes are plausible.",
    difficulty: "hard",
    requiredFiles: ["lib/mcp-health.mjs", "lib/browser-execution.mjs"],
    expectedSignals: ["transient", "cooldown", "retry"],
  },
  {
    id: "v163-stale-locator-recovery",
    prompt: "A stale element recovery silently re-clicks the wrong control after a re-render; the identity comparison is too permissive.",
    difficulty: "hard",
    requiredFiles: ["lib/browser-stale-recovery.mjs"],
    expectedSignals: ["identity", "confidence", "stale"],
  },
  {
    id: "v163-trivial-version-bump",
    prompt: "Bump the package version in package.json to the next patch level.",
    difficulty: "easy",
    requiredFiles: ["package.json"],
    expectedSignals: ["version"],
  },
  {
    id: "v163-packet-budget",
    prompt: "The decision packet exceeds its character budget and sheds the constraints section under pressure.",
    difficulty: "medium",
    requiredFiles: ["lib/decision-packet.mjs"],
    expectedSignals: ["budget", "constraints"],
  },
]

export function parseArgs(argv) {
  const args = {
    arm: "local",
    repeat: 3,
    live: false,
    liveBenchmarkConsent: false,
    json: false,
    tasks: null,
    piTelemetry: null,
    piReceipts: null,
    executor: "deterministic-fixture",
    profile: DEEPSEEK_PROFILE_NAME,
    answerTimeoutMs: 120_000,
    maxPacketChars: 24_000,
  }
  for (const entry of argv) {
    if (entry.startsWith("--arm=")) args.arm = entry.slice(6)
    else if (entry.startsWith("--repeat=")) args.repeat = Math.max(1, Math.min(50, Number(entry.slice(9)) || 3))
    else if (entry === "--live") args.live = true
    else if (entry === "--yes-i-have-authorized-a-live-benchmark") args.liveBenchmarkConsent = true
    else if (entry === "--json") args.json = true
    else if (entry.startsWith("--tasks=")) args.tasks = entry.slice(8)
    else if (entry.startsWith("--pi-telemetry=")) args.piTelemetry = entry.slice(15)
    else if (entry.startsWith("--pi-receipts=")) args.piReceipts = entry.slice(14)
    else if (entry.startsWith("--executor=")) args.executor = entry.slice(11)
    else if (entry.startsWith("--profile=")) args.profile = entry.slice(10) || DEEPSEEK_PROFILE_NAME
    else if (entry.startsWith("--answer-timeout-ms=")) args.answerTimeoutMs = Math.max(1_000, Math.min(600_000, Number(entry.slice(20)) || 120_000))
    else if (entry.startsWith("--max-packet-chars=")) args.maxPacketChars = Math.max(1_000, Math.min(200_000, Number(entry.slice(19)) || 24_000))
  }
  return args
}

function mean(values) {
  const list = values.filter((value) => Number.isFinite(value))
  if (!list.length) return null
  return Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(3))
}

function rate(values) {
  const list = values.filter((value) => value === true || value === false)
  if (!list.length) return null
  return Number((list.filter(Boolean).length / list.length).toFixed(4))
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0)
}

/**
 * Bounded maximum possible external effects for a live benchmark run.
 * Printed BEFORE any live run so the operator consents to a bounded blast
 * radius: at most one consultation per task repetition, at most one bounded
 * follow-up per consultation, at most one submit per consultation/follow-up.
 */
export function planLiveBenchmarkBounds(tasks, repeat) {
  const taskCount = Array.isArray(tasks) ? tasks.length : 0
  const iterations = Math.max(1, Math.min(50, Number(repeat) || 1))
  const maxConsultations = taskCount * iterations
  const maxFollowUps = maxConsultations
  const maxSubmits = maxConsultations + maxFollowUps
  return { maxConsultations, maxFollowUps, maxSubmits, taskCount, iterations }
}

/**
 * Create an isolated temporary fixture workspace for benchmark file reads.
 * Copies only the task-declared repo-relative files (bounded count and size)
 * into a fresh temp dir. Returns `{ dir, cleanup }`. Never writes into the
 * main working tree; cleanup removes the temp dir.
 */
export async function createIsolatedWorkspace({ root: repoRoot, tasks, fs = null } = {}) {
  const read = fs?.readFile || readFileImpl
  const write = fs?.writeFile || writeFile
  const mkTemp = fs?.mkdtemp || mkdtemp
  const remove = fs?.rm || rm
  const base = String(repoRoot || root)
  const wanted = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const relative of task.requiredFiles || []) {
      const name = String(relative || "")
      if (!name || name.startsWith("/") || name.includes("..") || name.includes("\0")) continue
      if (!wanted.includes(name)) wanted.push(name)
    }
  }
  const bounded = wanted.slice(0, 64)
  const dir = await mkTemp(path.join(os.tmpdir(), "ues-bench-"))
  let copied = 0
  let chars = 0
  for (const relative of bounded) {
    const absolute = path.join(base, relative)
    let text = ""
    try {
      text = String(await read(absolute, "utf8") || "")
    } catch {
      text = ""
    }
    if (text.length > 500_000) text = text.slice(0, 500_000)
    if (chars + text.length > 5_000_000) break
    const target = path.join(dir, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await write(target, text, "utf8")
    copied += 1
    chars += text.length
  }
  return {
    dir,
    copiedFiles: copied,
    chars,
    cleanup: async () => {
      try {
        await remove(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

// A deterministic local lane. It stands in for the Pi/UES executor: it "solves"
// a task by reading the declared relevant files, and it VERIFIES by checking the
// required signals are present in the files it read. That is a real check
// against real bytes on disk -- weak compared to running a model, but honest,
// reproducible, and not a self-report. It is labelled executorKind
// `deterministic-fixture` and must never be presented as model evidence.
async function localSolver(task, deps) {
  const startedAt = Date.now()
  const relevant = []
  for (const relative of task.requiredFiles || []) {
    const absolute = path.join(deps.root, relative)
    const text = await deps.readFile(absolute, "utf8").catch(() => "")
    relevant.push({ path: relative, chars: text.length, text })
  }
  const toolCalls = sum(relevant.map((row) => (row.chars > 0 ? 1 : 0))) + 1
  const verifiedSignals = (task.expectedSignals || []).filter((signal) =>
    relevant.some((row) => row.text.toLowerCase().includes(String(signal).toLowerCase())))
  const verifiedPass = verifiedSignals.length === (task.expectedSignals || []).length &&
    (task.expectedSignals || []).length > 0 &&
    relevant.every((row) => row.chars > 0)
  return {
    verifiedPass,
    // A false pass is a pass the local verifier claims without the evidence. The
    // harness computes it as a pass with missing evidence, not a judgement call.
    falsePass: verifiedPass && relevant.some((row) => row.chars === 0),
    toolCalls,
    readChars: sum(relevant.map((row) => row.chars)),
    durationMs: Date.now() - startedAt,
    tokens: { input: null, output: null, measured: false },
  }
}

function packetInputFor(task) {
  return {
    originalTask: task.prompt,
    requirements: [`Resolve: ${task.prompt.slice(0, 120)}`],
    constraints: ["MUST NOT change permission policy", "MUST NOT skip verification"],
    verification: ["targeted tests", "npm run eval:v16"],
    relevantFiles: (task.requiredFiles || []).map((file) => ({ path: file, relevant: true })),
    snippets: [],
    evidence: [],
  }
}

async function runLocalArm(tasks, repeat, deps) {
  const rows = []
  for (const task of tasks) {
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const solved = await localSolver(task, deps)
      rows.push({ taskId: task.id, difficulty: task.difficulty, iteration, ...solved })
    }
  }
  return {
    arm: "A-local-only",
    mode: "local",
    executorKind: "deterministic-fixture",
    executorNote: "deterministic pipeline fixture, not a model; never present as Pi model evidence",
    provider: null,
    tasks: rows.length,
    verifiedPassRate: rate(rows.map((row) => row.verifiedPass)),
    falsePassRate: rate(rows.map((row) => row.falsePass)),
    wallTimeMs: sum(rows.map((row) => row.durationMs)),
    toolCalls: sum(rows.map((row) => row.toolCalls)),
    browserToolCalls: 0,
    browserRetries: 0,
    webConsultations: 0,
    decisionPacketChars: 0,
    followUpDeltaChars: 0,
    providerFailures: 0,
    verifierRetries: 0,
    submitAttempts: 0,
    tokenMetrics: {
      piInputTokens: null,
      piOutputTokens: null,
      measured: false,
      reason: "local-only arm runs no model; Pi/API usage is not observable here",
    },
    qualityMeasured: true,
    perTask: rows,
  }
}

/**
 * Build arm A from paired measured Pi run receipts (`--executor=pi`).
 * The receipts file carries real per-task measurements produced by actual Pi/UES
 * runs; the harness validates the shape and reports what is measured, with
 * `null` + reason for anything absent. Nothing is estimated or fabricated.
 */
async function runPiReceiptsArm(tasks, repeat, deps) {
  const raw = await deps.readFile(deps.piReceiptsFile, "utf8").catch(() => null)
  if (raw === null) {
    return {
      arm: "A-pi-measured-receipts",
      mode: "pi-receipts",
      executorKind: "pi-measured-receipts",
      unavailable: true,
      reason: `pi receipts file could not be read: ${deps.piReceiptsFile}`,
      tasks: 0,
      perTask: [],
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    parsed = null
  }
  const rows = Array.isArray(parsed?.perTask) ? parsed.perTask : null
  if (!rows) {
    return {
      arm: "A-pi-measured-receipts",
      mode: "pi-receipts",
      executorKind: "pi-measured-receipts",
      unavailable: true,
      reason: "pi receipts file has no perTask array; refusing to fabricate model performance",
      tasks: 0,
      perTask: [],
    }
  }
  const byId = new Map(rows.filter((row) => row && row.taskId).map((row) => [String(row.taskId), row]))
  const out = []
  for (const task of tasks) {
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const measured = byId.get(String(task.id)) || null
      out.push({
        taskId: task.id,
        difficulty: task.difficulty,
        iteration,
        verifiedPass: measured?.verifiedPass === true,
        falsePass: measured?.falsePass === true,
        toolCalls: Number.isFinite(Number(measured?.toolCalls)) ? Number(measured.toolCalls) : null,
        wallTimeMs: Number.isFinite(Number(measured?.wallTimeMs)) ? Number(measured.wallTimeMs) : null,
        measured: Boolean(measured),
        missingReason: measured ? null : `no paired receipt for task ${task.id}`,
      })
    }
  }
  const measuredRows = out.filter((row) => row.measured)
  return {
    arm: "A-pi-measured-receipts",
    mode: "pi-receipts",
    executorKind: "pi-measured-receipts",
    provider: null,
    tasks: out.length,
    measuredTasks: measuredRows.length,
    verifiedPassRate: rate(measuredRows.map((row) => row.verifiedPass)),
    falsePassRate: rate(measuredRows.map((row) => row.falsePass)),
    wallTimeMs: measuredRows.length ? sum(measuredRows.map((row) => row.wallTimeMs || 0)) : null,
    toolCalls: measuredRows.length ? sum(measuredRows.map((row) => row.toolCalls || 0)) : null,
    browserToolCalls: 0,
    browserRetries: 0,
    webConsultations: 0,
    decisionPacketChars: 0,
    followUpDeltaChars: 0,
    providerFailures: 0,
    verifierRetries: 0,
    submitAttempts: 0,
    tokenMetrics: {
      piInputTokens: null,
      piOutputTokens: null,
      measured: false,
      reason: "import per-task token buckets via --pi-telemetry; never estimated here",
    },
    qualityMeasured: measuredRows.length > 0,
    perTask: out,
  }
}

// Deterministic provider double used when no live DeepSeek session is attached.
//
// It exists so the harness measures OUR pipeline -- escalation decisions, packet
// size, cache hits, follow-up deltas, local accept/reject -- which is
// deterministic and worth measuring. It is NOT a model and its advice is
// explicitly not evidence about DeepSeek's quality: it returns a fixed
// hypothesis about the first declared file so the advice path runs end to end.
function deterministicProviderDouble() {
  return {
    id: "deepseek-web",
    failureCodes: [],
    capability: async () => ({ state: "ready", supportsFollowUp: true, sessionReusable: true, maxPacketChars: 60_000 }),
    startSession: async () => ({ sessionId: "bench-double", state: "ready", reused: false }),
    consult: async (session, packet) => {
      const text = String(packet?.rendered || packet?.rawText || "")
      const file = text.match(/lib\/[a-z0-9.\-/]+\.mjs/)?.[0] || "lib/unknown.mjs"
      return {
        answer: JSON.stringify({
          summary: "Deterministic provider double: no model was consulted.",
          hypotheses: [`Inspect ${file} for the reported failure.`],
          recommendedApproach: [`Read ${file} and reproduce the failing assertion.`],
          filesToInspect: [file],
          risks: ["This advice is a fixture, not a real model response."],
          edgeCases: ["Behaviour differs from a live provider."],
          verificationSuggestions: ["Run the targeted test file."],
          confidence: 0.5,
        }),
      }
    },
    followUp: async () => ({
      answer: JSON.stringify({
        summary: "Deterministic provider double follow-up.",
        hypotheses: ["Re-read the new evidence."],
        recommendedApproach: ["Re-run the verifier."],
        filesToInspect: ["lib/benchmark-target.mjs"],
        risks: ["Fixture."],
        edgeCases: ["Fixture."],
        verificationSuggestions: ["Re-run the verifier."],
        confidence: 0.5,
      }),
    }),
    closeSession: async () => true,
  }
}

/**
 * Build the production DeepSeek adapter over a live managed worker with the
 * exact measured hooks the live smoke verified: counting invoke, real auth
 * probe, mode-routed domInspect (composer-vicinity + answer regions),
 * same-node transition begin/measure, and the shared browser telemetry.
 */
export function buildLiveDeepSeekAdapter({ worker, browserTelemetry, answerTimeoutMs, now, sleep, counters, bindBrowserClose = true }) {
  const countingInvoke = async (action, context) => {
    try {
      browserTelemetry?.recordDispatch?.()
    } catch {}
    if (action === "fill") counters.fillAttempts += 1
    if (action === "click") counters.submitAttempts += 1
    if (action === "snapshot") counters.snapshotAttempts += 1
    return worker.invoke(action, context)
  }
  const countingDomInspect = async (options) => {
    const mode = String(options?.mode || "composer-vicinity")
    if (mode === "deepseek-answer-regions") counters.snapshotAttempts += 1
    return worker.domInspect({ mode: "composer-vicinity", ...(options || {}), mode })
  }
  return createDeepSeekWebAdapter({
    capability: preflightBrowserCapability({
      tools: BENCH_TOOLS,
      requiredActions: ["snapshot", "click", "fill", "navigate"],
      providerName: "playwright-mcp",
    }),
    invoke: countingInvoke,
    // The REAL read-only auth probe. There is no asserted-auth shortcut: with
    // no observation the adapter reports needs-auth, never ready.
    authProbe: (options) => worker.authProbe({
      timeoutMs: options?.timeoutMs,
      answerSelectors: BENCH_ANSWER_SELECTORS,
      composerSelector: options?.composerSelector || "",
    }),
    // Measured locator + answer evidence, routed by mode. Answer-region reads
    // use the scoped `deepseek-answer-regions` path, never whole-page text.
    domInspect: countingDomInspect,
    // Same-node pre/post-fill transition evidence (read-only, handles stay
    // worker-side), exactly as the live smoke wires it.
    transitionBegin: async () => worker.domInspect({ mode: "send-transition-begin", timeoutMs: 30_000 }),
    transitionMeasure: async () => worker.domInspect({ mode: "send-transition-measure", timeoutMs: 30_000 }),
    telemetry: browserTelemetry,
    answerTimeoutMs,
    now,
    sleep,
    // Bench runs MANY consultations over one worker lifetime, so adapter
    // sessions stay logical here (closeSession marks CLOSED only) and the
    // bench closes the worker once at the end via the same close hook.
    // Single-shot smoke binds per-session close instead.
    ...(bindBrowserClose
      ? {
        closeBrowser: async () => {
          await worker.close().catch(() => null)
        },
      }
      : {}),
  })
}

/**
 * Attach the live managed worker using the SAME policy as the production
 * smoke: workerModePlan({ live: true, profile }).scriptArgs, then fail closed
 * when the worker does not report the expected persistent profile. Never
 * duplicates worker-mode policy; imports it.
 */
export async function attachLiveWorker({ profile, spawnImpl = spawn, now, sleep, timeoutMs = 60_000 } = {}) {
  const plan = workerModePlan({ live: true, profile: profile || DEEPSEEK_PROFILE_NAME })
  const transport = spawnBrowserWorkerTransport(workerScript, {
    spawnImpl,
    cwd: root,
    scriptArgs: plan.scriptArgs,
  })
  if (!transport) {
    return { ok: false, plan, reason: "managed browser worker could not be started" }
  }
  const worker = createBrowserWorkerClient({ transport, process: transport.process })
  const capability = await worker.capability().catch(() => null)
  if (!capability || capability.state !== "ready" || capability.interactive !== true) {
    await worker.close().catch(() => null)
    return { ok: false, plan, reason: capability?.reason || "managed browser is not ready", capability }
  }
  const violation = workerModeViolation(plan, capability)
  if (violation) {
    await worker.close().catch(() => null)
    return { ok: false, plan, reason: violation, capability, expectedProfileMode: WORKER_PROFILE_MODE.PERSISTENT }
  }
  return { ok: true, plan, worker, capability }
}

/**
 * Live readiness over the REAL auth path: one entry navigation, then the
 * existing bounded SPA hydration settle. Read-only; no click/type/submit.
 * Returns the settle result; callers fail closed unless state is READY.
 */
export async function ensureLiveReady(worker, { entryUrl = ENTRY_URL } = {}) {
  await worker.invoke("navigate", { url: entryUrl, waitUntil: "domcontentloaded" })
  return waitForAuthenticatedPage(worker)
}

async function runWebArm(tasks, repeat, deps) {
  // ONE shared web telemetry for the whole arm: both the consultation and any
  // follow-up record into it, so per-arm counters are measured once.
  const webTelemetry = deps.webTelemetry || createWebReasoningTelemetry()
  // ONE shared browser telemetry, passed through the adapter into the browser
  // execution path so receipts and dispatches are measured, not defaulted.
  const browserTelemetry = deps.browserTelemetry || createBrowserTelemetry()
  const counters = deps.counters || { fillAttempts: 0, submitAttempts: 0, snapshotAttempts: 0 }
  const rows = []
  const provider = deps.liveAdapter || deterministicProviderDouble()
  const registry = deps.registry || createWebReasoningRegistry([provider])

  for (const task of tasks) {
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const startedAt = deps.now()
      const solved = await localSolver(task, deps)
      const localDuration = deps.now() - startedAt
      const submitsBefore = counters.submitAttempts

      clearDecisionPacketCache()
      const result = await runWebConsultation(
        {
          mode: "auto",
          task: task.prompt,
          knownFiles: task.requiredFiles || [],
          budget: { maxPacketChars: deps.maxPacketChars },
          keepSession: true,
          // Keep the session open: the verifier-failure branch below reuses
          // result._session for a delta follow-up. Default close-on-return
          // would hand it a CLOSED session (deepseek-session-lost).
        },
        // Shared telemetry: consultation counts land in the arm accumulator.
        { registry, telemetry: webTelemetry, now: deps.now, sleep: deps.sleep },
      )

      // Per-task follow-up accounting is stored ON THE ROW from this single
      // computation. The arm aggregate sums rows only -- never telemetry plus
      // rows -- so values can be neither lost nor double-counted.
      let followUpChars = 0
      let verifierRetries = 0
      if (result.consulted && result.outcome !== "advice-accepted") {
        // The verifier failed after implementation. This is the follow-up delta
        // path: same healthy session, only the new diff/evidence.
        const first = buildDecisionPacket(packetInputFor(task), { maxPacketChars: deps.maxPacketChars })
        const next = buildDecisionPacket({
          ...packetInputFor(task),
          evidence: [{ kind: "test", source: "targeted tests", text: "verifier still fails" }],
        }, { maxPacketChars: deps.maxPacketChars })
        const delta = buildFollowUpDelta(first, next)
        followUpChars = delta.chars
        const followUp = await runWebFollowUp(
          {
            mode: "auto",
            task: task.prompt,
            decision: result.decision,
            delta,
            previousPacket: first,
            nextPacket: next,
            knownFiles: task.requiredFiles || [],
            session: result._session,
            attempt: 1,
          },
          { registry, now: deps.now, sleep: deps.sleep, telemetry: webTelemetry },
        )
        verifierRetries = followUp.followedUp ? 1 : 0
      }

      rows.push({
        taskId: task.id,
        difficulty: task.difficulty,
        iteration,
        verifiedPass: solved.verifiedPass,
        falsePass: solved.falsePass,
        toolCalls: solved.toolCalls,
        readChars: solved.readChars,
        durationMs: deps.now() - startedAt,
        localDurationMs: localDuration,
        followUpChars,
        verifierRetries,
        submitAttempts: counters.submitAttempts - submitsBefore,
        consultation: {
          consulted: result.consulted,
          outcome: result.outcome,
          escalated: result.decision?.escalate === true,
          signals: result.decision?.signals || [],
          reason: result.reason ?? null,
        },
      })
    }
  }

  const snapshot = webTelemetry.snapshot()
  const browserSnapshot = browserTelemetry.snapshot()
  const liveCompletions = rows.filter((row) =>
    row.consultation.consulted === true &&
    (row.consultation.outcome === "advice-accepted" || row.consultation.outcome === "advice-rejected")).length
  return {
    arm: "B-pi-ues-plus-deepseek-web-auto",
    mode: "auto",
    provider: "deepseek-web",
    liveProvider: deps.live === true,
    liveProviderConsultations: deps.live === true ? liveCompletions : 0,
    providerKind: deps.live ? "live-deepseek-web" : "deterministic-provider-double",
    tasks: rows.length,
    verifiedPassRate: rate(rows.map((row) => row.verifiedPass)),
    falsePassRate: rate(rows.map((row) => row.falsePass)),
    wallTimeMs: sum(rows.map((row) => row.durationMs)),
    toolCalls: sum(rows.map((row) => row.toolCalls)),
    browserToolCalls: browserSnapshot.browserToolCalls,
    browserRetries: browserSnapshot.browserRetries,
    webConsultations: snapshot.webReasoningCalls,
    webEscalations: snapshot.webReasoningEscalations,
    webSkipped: snapshot.webReasoningSkipped,
    webFallbacks: snapshot.webReasoningFallbacks,
    decisionPacketChars: snapshot.decisionPacketChars,
    decisionPacketFiles: snapshot.decisionPacketFiles,
    decisionPacketCacheHits: snapshot.decisionPacketCacheHits,
    // Single authoritative source: the per-task rows. Telemetry also records
    // follow-up deltas, but adding both would double-count.
    followUpDeltaChars: sum(rows.map((row) => row.followUpChars || 0)),
    providerFailures: snapshot.deepseekUnavailable + snapshot.deepseekTimeouts + snapshot.deepseekParseFailures,
    deepseekTimeouts: snapshot.deepseekTimeouts,
    deepseekParseFailures: snapshot.deepseekParseFailures,
    deepseekAuthRequired: snapshot.deepseekAuthRequired,
    localVerificationAccepts: snapshot.localVerificationAccepts,
    localVerificationRejects: snapshot.localVerificationRejects,
    verifierRetries: sum(rows.map((row) => row.verifierRetries || 0)),
    submitAttempts: counters.submitAttempts,
    tokenMetrics: {
      piInputTokens: null,
      piOutputTokens: null,
      measured: false,
      reason: "no model provider is attached to this harness; Pi/API usage is not observable here",
      estimatedTokensSent: snapshot.estimatedTokensSent,
      estimatedTokensSaved: snapshot.estimatedTokensSaved,
      estimatedTokenBasis: "chars/4 heuristic for packet accounting only, never a provider measurement",
    },
    qualityMeasured: true,
    perTask: rows,
  }
}

/**
 * Reads measured Pi/API token usage from a UES run-telemetry file.
 *
 * Returns `null` when no file was supplied or when the file carries no measured
 * bucket, so the benchmark reports `null` rather than a fabricated number.
 */
async function readPiUsage(file, deps) {
  if (!file) return null
  try {
    const raw = await deps.readFile(file, "utf8")
    const rows = String(raw).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    if (!rows.length) return null
    const input = rows.reduce((sum, row) => sum + finite(row.usage?.inputTokens ?? row.inputTokens ?? row.usage?.input), 0)
    const output = rows.reduce((sum, row) => sum + finite(row.usage?.outputTokens ?? row.outputTokens ?? row.usage?.output), 0)
    const measured = input > 0 || output > 0
    return {
      piInputTokens: measured ? input : null,
      piOutputTokens: measured ? output : null,
      measured,
      reason: measured ? "measured from the supplied UES run telemetry" : "telemetry file contained no measured token bucket",
    }
  } catch {
    return {
      piInputTokens: null,
      piOutputTokens: null,
      measured: false,
      reason: `pi telemetry file could not be read: ${file}`,
    }
  }
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function compare(local, web) {
  const fields = [
    "verifiedPassRate",
    "falsePassRate",
    "wallTimeMs",
    "toolCalls",
    "browserToolCalls",
    "browserRetries",
    "webConsultations",
    "decisionPacketChars",
    "followUpDeltaChars",
    "providerFailures",
    "verifierRetries",
  ]
  const rows = fields.map((field) => ({
    metric: field,
    a: local?.[field] ?? null,
    b: web?.[field] ?? null,
    // Deltas are only computed when BOTH arms produced a number. A null is
    // carried through as null, never coerced to 0.
    delta: Number.isFinite(local?.[field]) && Number.isFinite(web?.[field])
      ? Number((web[field] - local[field]).toFixed(3))
      : null,
  }))
  return {
    fields: rows,
    // A conclusion is only drawn when both arms produced measured values.
    conclusion: rows.every((row) => row.delta !== null)
      ? "measured-both-arms"
      : "incomplete-measurement-no-conclusion",
    claimsVerified: false,
  }
}

/**
 * Live readiness derived from ACTUAL measurements, never hard-coded. True only
 * when at least one real live DeepSeek consultation completed through the live
 * provider in this run.
 */
export function evaluateLiveReadiness({ live, liveCompletions } = {}) {
  const consultations = Math.max(0, Number(liveCompletions) || 0)
  const measured = live === true && consultations > 0
  return {
    liveProviderAttached: live === true,
    liveProviderConsultations: live === true ? consultations : 0,
    liveProviderMeasured: measured,
    deterministicOnly: live !== true,
  }
}

export async function runBenchmark(options = {}) {
  const live = options.live === true
  const liveConsent = options.liveBenchmarkConsent === true || options.yesLiveBenchmark === true
  const profile = String(options.profile || DEEPSEEK_PROFILE_NAME)
  const executor = String(options.executor || "deterministic-fixture")

  const deps = {
    root,
    readFile: options.readFile || ((file, encoding) => readFileImpl(file, encoding)),
    now: options.now || (() => Date.now()),
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    live,
    liveInvoke: options.liveInvoke || null,
    closeBrowser: options.closeBrowser || null,
    maxPacketChars: options.maxPacketChars || 24_000,
    answerTimeoutMs: options.answerTimeoutMs || 120_000,
    piTelemetryFile: options.piTelemetryFile || options.piTelemetry || null,
    piReceiptsFile: options.piReceiptsFile || options.piReceipts || null,
    webTelemetry: options.webTelemetry || null,
    browserTelemetry: options.browserTelemetry || null,
    counters: options.counters || null,
    registry: options.registry || null,
    liveAdapter: options.liveAdapter || null,
  }

  let tasks = DEFAULT_TASKS
  if (options.tasksFile) {
    const raw = await deps.readFile(options.tasksFile, "utf8")
    tasks = JSON.parse(raw)
  } else if (Array.isArray(options.tasks)) {
    tasks = options.tasks
  }

  const repeat = Math.max(1, Math.min(50, Number(options.repeat) || 3))
  const bounds = planLiveBenchmarkBounds(tasks, repeat)

  // Explicit live consent gate. --live may submit MULTIPLE messages, so a
  // second guard is required. Without it nothing is spawned, nothing is
  // submitted, and the run reports SKIPPED with the bounded maximums.
  if (live && !liveConsent) {
    return {
      schemaVersion: 1,
      kind: "ues-v163-web-reasoning-ab-benchmark",
      generatedAt: new Date(deps.now()).toISOString(),
      taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
      tasksPerArm: tasks.length,
      repeat,
      liveProvider: true,
      liveBenchmarkConsent: false,
      liveBounds: bounds,
      taskIds: tasks.map((task) => task.id),
      fingerprint: createHash("sha256")
        .update(JSON.stringify(tasks.map((task) => [task.id, task.requiredFiles, task.expectedSignals])))
        .digest("hex")
        .slice(0, 16),
      arms: { a: null, b: null },
      comparison: { fields: [], conclusion: "incomplete-measurement-no-conclusion", claimsVerified: false },
      benchmarkReadiness: {
        deterministicArmsMeasured: false,
        liveProviderRequired: true,
        liveProviderAttached: false,
        liveProviderConsultations: 0,
        liveProviderMeasured: false,
        deterministicOnly: false,
        status: "SKIPPED-live-consent-required-0-submits",
      },
      submitAttempts: 0,
      qualityMeasured: false,
      claimsVerified: false,
    }
  }

  // Real provider attach for the B arm via the production live worker plan.
  // Without an injected liveInvoke (tests) the worker is spawned with
  // plan.scriptArgs (--live --profile=...); an ephemeral worker fails closed.
  let liveWorker = null
  let livePlan = null
  let liveCapability = null
  let spawnedWorker = false
  if (live && !deps.liveInvoke) {
    const attached = await attachLiveWorker({
      profile,
      spawnImpl: options.spawnImpl || spawn,
      now: deps.now,
      sleep: deps.sleep,
    })
    livePlan = attached.plan || null
    if (!attached.ok) {
      return {
        schemaVersion: 1,
        kind: "ues-v163-web-reasoning-ab-benchmark",
        generatedAt: new Date(deps.now()).toISOString(),
        taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
        tasksPerArm: tasks.length,
        repeat,
        liveProvider: true,
        liveBenchmarkConsent: true,
        liveBounds: bounds,
        livePlan: livePlan ? { mode: livePlan.mode, expectedProfileMode: livePlan.expectedProfileMode, scriptArgs: livePlan.scriptArgs } : null,
        taskIds: tasks.map((task) => task.id),
        fingerprint: "live-attach-failed",
        arms: { a: null, b: null },
        comparison: { fields: [], conclusion: "incomplete-measurement-no-conclusion", claimsVerified: false },
        benchmarkReadiness: {
          deterministicArmsMeasured: false,
          liveProviderRequired: true,
          liveProviderAttached: false,
          liveProviderConsultations: 0,
          liveProviderMeasured: false,
          deterministicOnly: false,
          status: `live-worker-attach-failed:${attached.reason || "unknown"}`,
        },
        submitAttempts: 0,
        qualityMeasured: false,
        claimsVerified: false,
      }
    }
    liveWorker = attached.worker
    liveCapability = attached.capability
    spawnedWorker = true
    deps.liveInvoke = (action, context) => liveWorker.invoke(action, context)
    deps.closeBrowser = async () => {
      await liveWorker.close().catch(() => null)
    }
  }

  // Live readiness over the REAL auth path (no asserted login). One entry
  // navigation plus the bounded SPA hydration settle; anything but READY fails
  // closed with zero submits. Runs for spawned workers and injected
  // worker-like clients alike.
  const readyWorker = liveWorker || options.liveWorker || null
  let liveSettled = null
  if (live && readyWorker) {
    try {
      liveSettled = await ensureLiveReady(readyWorker)
    } catch (error) {
      liveSettled = { state: "TIMEOUT", reason: `live-readiness-threw:${error?.message || error}` }
    }
    if (!liveSettled || liveSettled.state !== AUTH_PROBE_STATE.READY) {
      if (spawnedWorker) await liveWorker.close().catch(() => null)
      return {
        schemaVersion: 1,
        kind: "ues-v163-web-reasoning-ab-benchmark",
        generatedAt: new Date(deps.now()).toISOString(),
        taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
        tasksPerArm: tasks.length,
        repeat,
        liveProvider: true,
        liveBenchmarkConsent: true,
        liveBounds: bounds,
        livePlan: livePlan ? { mode: livePlan.mode, expectedProfileMode: livePlan.expectedProfileMode, scriptArgs: livePlan.scriptArgs } : null,
        taskIds: tasks.map((task) => task.id),
        fingerprint: "live-readiness-not-ready",
        arms: { a: null, b: null },
        comparison: { fields: [], conclusion: "incomplete-measurement-no-conclusion", claimsVerified: false },
        benchmarkReadiness: {
          deterministicArmsMeasured: false,
          liveProviderRequired: true,
          liveProviderAttached: true,
          liveProviderConsultations: 0,
          liveProviderMeasured: false,
          deterministicOnly: false,
          status: `live-readiness-not-ready:${liveSettled?.state || "unknown"}:${liveSettled?.reason || "no-session-signal"}`,
        },
        submitAttempts: 0,
        qualityMeasured: false,
        claimsVerified: false,
      }
    }
  }

  // Isolated fixture workspace: task file reads resolve inside a temp copy,
  // never destructively against the main working tree. Removed afterwards.
  const workspace = await createIsolatedWorkspace({ root, tasks })
  const solverDeps = { ...deps, root: workspace.dir }
  // Shared telemetry + counters for the B arm when the caller did not inject
  // them (tests may inject to assert ownership).
  const webTelemetry = deps.webTelemetry || createWebReasoningTelemetry()
  const browserTelemetry = deps.browserTelemetry || createBrowserTelemetry()
  const counters = deps.counters || { fillAttempts: 0, submitAttempts: 0, snapshotAttempts: 0 }

  // Production live adapter over the attached worker (same hooks as smoke).
  // Test seam: options.liveWorker (a full worker-like client) may be injected
  // to exercise the real adapter + readiness deterministically without a
  // browser. Otherwise an injected liveInvoke also requires explicit
  // liveAuthProbe/liveDomInspect hooks; asserted-auth fallbacks are refused.
  let liveAdapter = deps.liveAdapter || null
  if (live && !liveAdapter) {
    const workerLike = options.liveWorker || liveWorker || null
    if (workerLike && typeof workerLike.invoke === "function") {
      if (typeof workerLike.authProbe !== "function" || typeof workerLike.domInspect !== "function") {
        if (spawnedWorker) await liveWorker?.close().catch(() => null)
        await workspace.cleanup()
        return {
          schemaVersion: 1,
          kind: "ues-v163-web-reasoning-ab-benchmark",
          generatedAt: new Date(deps.now()).toISOString(),
          taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
          tasksPerArm: tasks.length,
          repeat,
          liveProvider: true,
          liveBenchmarkConsent: true,
          liveBounds: bounds,
          taskIds: tasks.map((task) => task.id),
          fingerprint: "live-hooks-missing",
          arms: { a: null, b: null },
          comparison: { fields: [], conclusion: "incomplete-measurement-no-conclusion", claimsVerified: false },
          benchmarkReadiness: {
            deterministicArmsMeasured: false,
            liveProviderRequired: true,
            liveProviderAttached: true,
            liveProviderConsultations: 0,
            liveProviderMeasured: false,
            deterministicOnly: false,
            status: "live-hooks-missing:authProbe-domInspect-required-no-fake-auth",
          },
          submitAttempts: 0,
          qualityMeasured: false,
          claimsVerified: false,
        }
      }
      liveAdapter = buildLiveDeepSeekAdapter({
        worker: workerLike,
        browserTelemetry,
        answerTimeoutMs: deps.answerTimeoutMs,
        now: deps.now,
        sleep: deps.sleep,
        counters,
        // Multi-task bench lifetime: bench owns the worker close (see above).
        bindBrowserClose: false,
      })
    } else if (deps.liveInvoke) {
      if (spawnedWorker) await liveWorker?.close().catch(() => null)
      await workspace.cleanup()
      return {
        schemaVersion: 1,
        kind: "ues-v163-web-reasoning-ab-benchmark",
        generatedAt: new Date(deps.now()).toISOString(),
        taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
        tasksPerArm: tasks.length,
        repeat,
        liveProvider: true,
        liveBenchmarkConsent: true,
        liveBounds: bounds,
        taskIds: tasks.map((task) => task.id),
        fingerprint: "live-hooks-missing",
        arms: { a: null, b: null },
        comparison: { fields: [], conclusion: "incomplete-measurement-no-conclusion", claimsVerified: false },
        benchmarkReadiness: {
          deterministicArmsMeasured: false,
          liveProviderRequired: true,
          liveProviderAttached: true,
          liveProviderConsultations: 0,
          liveProviderMeasured: false,
          deterministicOnly: false,
          status: "live-hooks-missing:authProbe-domInspect-required-no-fake-auth",
        },
        submitAttempts: 0,
        qualityMeasured: false,
        claimsVerified: false,
      }
    }
  }

  const wantLocal = options.arm !== "B"
  const wantWeb = options.arm !== "A"

  let local = null
  let web = null
  try {
    if (wantLocal) {
      if (executor === "pi") {
        local = await runPiReceiptsArm(tasks, repeat, { ...solverDeps, piReceiptsFile: deps.piReceiptsFile })
      } else {
        local = await runLocalArm(tasks, repeat, solverDeps)
      }
    }
    if (wantWeb) {
      web = await runWebArm(tasks, repeat, {
        ...solverDeps,
        live,
        liveAdapter,
        registry: deps.registry || null,
        webTelemetry,
        browserTelemetry,
        counters,
        now: deps.now,
        sleep: deps.sleep,
        maxPacketChars: deps.maxPacketChars,
      })
    }
  } finally {
    await workspace.cleanup()
    if (spawnedWorker) await liveWorker?.close().catch(() => null)
  }

  // Pi/API token accounting comes from a REAL run-telemetry file when one is
  // supplied. It is never estimated into the pi* fields: a missing measurement
  // stays `null` with a reason, which is the only honest option.
  const piUsage = await readPiUsage(deps.piTelemetryFile, deps)
  if (piUsage) {
    if (local) local.tokenMetrics = { ...local.tokenMetrics, ...piUsage, arm: "A" }
    if (web) web.tokenMetrics = { ...web.tokenMetrics, ...piUsage, arm: "B" }
  }

  const liveCompletions = web?.liveProviderConsultations || 0
  const readiness = evaluateLiveReadiness({ live, liveCompletions })
  const deterministicMeasured = Boolean(local?.qualityMeasured && web?.qualityMeasured) && !live

  return {
    schemaVersion: 1,
    kind: "ues-v163-web-reasoning-ab-benchmark",
    generatedAt: new Date(deps.now()).toISOString(),
    taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
    tasksPerArm: tasks.length,
    repeat,
    liveProvider: live,
    liveBenchmarkConsent: live ? true : undefined,
    liveBounds: live ? bounds : undefined,
    livePlan: livePlan ? { mode: livePlan.mode, expectedProfileMode: livePlan.expectedProfileMode, scriptArgs: livePlan.scriptArgs } : undefined,
    taskIds: tasks.map((task) => task.id),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(tasks.map((task) => [task.id, task.requiredFiles, task.expectedSignals])))
      .digest("hex")
      .slice(0, 16),
    arms: { a: local, b: web },
    comparison: compare(local, web),
    // Readiness is measured, never hard-coded: true only when a real live
    // consultation actually completed through the live provider in this run.
    benchmarkReadiness: {
      deterministicArmsMeasured: Boolean(local?.qualityMeasured && web?.qualityMeasured),
      liveProviderRequired: true,
      liveProviderAttached: readiness.liveProviderAttached,
      liveProviderConsultations: readiness.liveProviderConsultations,
      liveProviderMeasured: readiness.liveProviderMeasured,
      deterministicOnly: readiness.deterministicOnly,
      status: live
        ? (readiness.liveProviderMeasured ? "live-provider-measured" : "live-provider-attached-no-completion")
        : (deterministicMeasured ? "deterministic-only-no-live-claim" : "incomplete-measurement-no-conclusion"),
    },
    submitAttempts: web?.submitAttempts ?? 0,
    qualityMeasured: Boolean(local?.qualityMeasured && web?.qualityMeasured),
    claimsVerified: false,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.live && !args.liveBenchmarkConsent) {
    const tasks = DEFAULT_TASKS
    const bounds = planLiveBenchmarkBounds(tasks, args.repeat)
    console.log("V16.3 web-reasoning A/B benchmark SKIPPED (live consent required)")
    console.log(`task set: builtin-deterministic-v163; tasks: ${bounds.taskCount}; repeat: ${bounds.iterations}`)
    console.log(`bounded maximums if consented: consultations=${bounds.maxConsultations} followUps=${bounds.maxFollowUps} external submits=${bounds.maxSubmits}`)
    console.log("status: SKIPPED-live-consent-required-0-submits; submitAttempts: 0")
    console.log("next: re-run with --live --yes-i-have-authorized-a-live-benchmark (ONE bounded live benchmark)")
    process.exitCode = 2
    return
  }
  const result = await runBenchmark({
    arm: args.arm,
    repeat: args.repeat,
    live: args.live,
    liveBenchmarkConsent: args.liveBenchmarkConsent,
    tasksFile: args.tasks,
    piTelemetryFile: args.piTelemetry,
    piReceiptsFile: args.piReceipts,
    executor: args.executor,
    profile: args.profile,
    answerTimeoutMs: args.answerTimeoutMs,
    maxPacketChars: args.maxPacketChars,
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log("V16.3 web-reasoning A/B benchmark (measured values only)")
    console.log(`task set: ${result.taskSet}; tasks/arm: ${result.tasksPerArm}; repeat: ${result.repeat}`)
    if (result.liveBounds) {
      console.log(`live bounds: consultations=${result.liveBounds.maxConsultations} followUps=${result.liveBounds.maxFollowUps} external submits=${result.liveBounds.maxSubmits}`)
    }
    for (const arm of [result.arms.a, result.arms.b]) {
      if (!arm) continue
      console.log("")
      console.log(`${arm.arm}`)
      if (arm.executorKind) console.log(`  executor_kind:       ${arm.executorKind}`)
      console.log(`  verified_pass_rate:  ${arm.verifiedPassRate}`)
      console.log(`  false_pass_rate:     ${arm.falsePassRate}`)
      console.log(`  wall_time_ms:        ${arm.wallTimeMs}`)
      console.log(`  tool_calls:          ${arm.toolCalls}`)
      console.log(`  browser_tool_calls:  ${arm.browserToolCalls}`)
      console.log(`  browser_retries:     ${arm.browserRetries}`)
      console.log(`  web_consultations:   ${arm.webConsultations}`)
      console.log(`  decision_packet_chars:${arm.decisionPacketChars}`)
      console.log(`  follow_up_delta_chars:${arm.followUpDeltaChars}`)
      console.log(`  provider_failures:   ${arm.providerFailures}`)
      console.log(`  verifier_retries:    ${arm.verifierRetries}`)
      if (arm.submitAttempts !== undefined) console.log(`  submit_attempts:     ${arm.submitAttempts}`)
      console.log(`  pi_input_tokens:     ${arm.tokenMetrics.piInputTokens} (${arm.tokenMetrics.reason})`)
      if (arm.providerKind) console.log(`  provider_kind:       ${arm.providerKind}`)
    }
    console.log("")
    console.log(`conclusion: ${result.comparison.conclusion}; claims_verified: ${result.claimsVerified}`)
    console.log(`readiness:  ${result.benchmarkReadiness.status}`)
  }

  const outDir = path.join(root, ".ues-work", "bench")
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, `web-reasoning-ab-${result.fingerprint}.json`)
  await writeFile(file, JSON.stringify(result, null, 2), "utf8")
  if (!args.json) console.log(`\nreceipt: ${path.relative(root, file).replaceAll("\\", "/")}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`benchmark failed: ${error?.message || error}`)
    process.exitCode = 1
  })
}
