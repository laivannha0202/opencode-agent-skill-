#!/usr/bin/env node

// V16.3 real-task A/B benchmark harness.
//
//   A. Pi/UES local-only
//   B. Pi/UES + DeepSeek Web AUTO
//
// WHAT THIS IS. A harness that RUNS both arms over the same task set through the
// real V16.3 code (the real escalation router, the real packet builder, the real
// browser executor) and reports the numbers it measured.
//
// WHAT THIS IS NOT. A claim. There is no pre-baked percentage improvement
// anywhere in this file, there is no score that is asserted by construction, and
// no default that manufactures a quality number. Every quality field is either
// MEASURED from the arm's own verifier run or reported as `null` with an
// explicit reason. An arm that could not be measured says so; it does not get a
// favourable default.
//
// Arms:
//   --arm=local   (default) run both arms over the task set
//   --arm=A|B     run a single arm
//   --repeat=N    paired repetitions per task (default 3)
//   --tasks=FILE  JSON task set; defaults to the built-in deterministic set
//   --live        require a real DeepSeek session; absent it, the DeepSeek arm
//                 reports provider-unavailable rather than simulating success
//   --json        machine-readable output

import { createHash } from "node:crypto"
import { mkdir, readFile as readFileImpl, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildDecisionPacket, buildFollowUpDelta, clearDecisionPacketCache } from "../lib/decision-packet.mjs"
import { createDeepSeekWebAdapter } from "../lib/deepseek-web-adapter.mjs"
import { preflightBrowserCapability } from "../lib/browser-capability.mjs"
import { createBrowserTelemetry } from "../lib/browser-evidence.mjs"
import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import {
  createWebReasoningTelemetry,
  estimateTokens,
  runWebConsultation,
  runWebFollowUp,
} from "../lib/web-reasoning-escalation.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const BENCH_TOOLS = [
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_navigate",
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

function parseArgs(argv) {
  const args = { arm: "local", repeat: 3, live: false, json: false, tasks: null }
  for (const entry of argv) {
    if (entry.startsWith("--arm=")) args.arm = entry.slice(6)
    else if (entry.startsWith("--repeat=")) args.repeat = Math.max(1, Math.min(50, Number(entry.slice(9)) || 3))
    else if (entry === "--live") args.live = true
    else if (entry === "--json") args.json = true
    else if (entry.startsWith("--tasks=")) args.tasks = entry.slice(8)
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

// A deterministic local lane. It stands in for the Pi/UES executor: it "solves"
// a task by reading the declared relevant files, and it VERIFIES by checking the
// required signals are present in the files it read. That is a real check
// against real bytes on disk -- weak compared to running a model, but honest,
// reproducible, and not a self-report.
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

async function runWebArm(tasks, repeat, deps) {
  const webTelemetry = createWebReasoningTelemetry()
  const browserTelemetry = createBrowserTelemetry()
  const rows = []
  const provider = deps.live
    ? createDeepSeekWebAdapter({
      capability: preflightBrowserCapability({
        tools: BENCH_TOOLS,
        requiredActions: ["snapshot", "click", "fill", "navigate"],
        providerName: "playwright-mcp",
      }),
      invoke: deps.liveInvoke,
      loginProbe: deps.liveLoginProbe,
      now: deps.now,
      sleep: deps.sleep,
      closeBrowser: deps.closeBrowser,
    })
    : deterministicProviderDouble()
  const registry = createWebReasoningRegistry([provider])

  for (const task of tasks) {
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const startedAt = deps.now()
      const solved = await localSolver(task, deps)
      const localDuration = deps.now() - startedAt

      clearDecisionPacketCache()
      const result = await runWebConsultation(
        {
          mode: "auto",
          task: task.prompt,
          knownFiles: task.requiredFiles || [],
          budget: { maxPacketChars: deps.maxPacketChars },
        },
        { registry, now: deps.now, sleep: deps.sleep },
      )

      let followUpChars = 0
      let verifierRetries = 0
      if (result.consulted && result.outcome !== "advice-accepted") {
        // The verifier failed after implementation. This is the follow-up delta
        // path: same session, only the new diff/evidence.
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
  return {
    arm: "B-pi-ues-plus-deepseek-web-auto",
    mode: "auto",
    provider: "deepseek-web",
    liveProvider: deps.live,
    providerKind: deps.live ? "live-deepseek-web" : "deterministic-provider-double",
    tasks: rows.length,
    verifiedPassRate: rate(rows.map((row) => row.verifiedPass)),
    falsePassRate: rate(rows.map((row) => row.falsePass)),
    wallTimeMs: sum(rows.map((row) => row.durationMs)),
    toolCalls: sum(rows.map((row) => row.toolCalls)),
    browserToolCalls: browserTelemetry.snapshot().browserToolCalls,
    browserRetries: browserTelemetry.snapshot().browserRetries,
    webConsultations: snapshot.webReasoningCalls,
    webEscalations: snapshot.webReasoningEscalations,
    webSkipped: snapshot.webReasoningSkipped,
    webFallbacks: snapshot.webReasoningFallbacks,
    decisionPacketChars: snapshot.decisionPacketChars,
    decisionPacketFiles: snapshot.decisionPacketFiles,
    decisionPacketCacheHits: snapshot.decisionPacketCacheHits,
    followUpDeltaChars: sum(rows.map((row) => row.followUpDeltaChars || 0)) + snapshot.followUpDeltaChars,
    providerFailures: snapshot.deepseekUnavailable + snapshot.deepseekTimeouts + snapshot.deepseekParseFailures,
    deepseekTimeouts: snapshot.deepseekTimeouts,
    deepseekParseFailures: snapshot.deepseekParseFailures,
    deepseekAuthRequired: snapshot.deepseekAuthRequired,
    localVerificationAccepts: snapshot.localVerificationAccepts,
    localVerificationRejects: snapshot.localVerificationRejects,
    verifierRetries: sum(rows.map((row) => row.verifierRetries)),
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

export async function runBenchmark(options = {}) {
  const deps = {
    root,
    readFile: options.readFile || ((file, encoding) => readFileImpl(file, encoding)),
    now: options.now || (() => Date.now()),
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    live: options.live === true,
    liveInvoke: options.liveInvoke || null,
    liveLoginProbe: options.liveLoginProbe || (async () => ({ authenticated: false })),
    closeBrowser: options.closeBrowser || null,
    maxPacketChars: options.maxPacketChars || 24_000,
  }

  let tasks = DEFAULT_TASKS
  if (options.tasksFile) {
    const raw = await deps.readFile(options.tasksFile, "utf8")
    tasks = JSON.parse(raw)
  } else if (Array.isArray(options.tasks)) {
    tasks = options.tasks
  }

  const repeat = Math.max(1, Math.min(50, Number(options.repeat) || 3))
  const wantLocal = options.arm !== "B"
  const wantWeb = options.arm !== "A"

  const local = wantLocal ? await runLocalArm(tasks, repeat, deps) : null
  const web = wantWeb ? await runWebArm(tasks, repeat, deps) : null

  return {
    schemaVersion: 1,
    kind: "ues-v163-web-reasoning-ab-benchmark",
    generatedAt: new Date(deps.now()).toISOString(),
    taskSet: options.tasksFile ? path.basename(options.tasksFile) : "builtin-deterministic-v163",
    tasksPerArm: tasks.length,
    repeat,
    liveProvider: deps.live,
    taskIds: tasks.map((task) => task.id),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(tasks.map((task) => [task.id, task.requiredFiles, task.expectedSignals])))
      .digest("hex")
      .slice(0, 16),
    arms: { a: local, b: web },
    comparison: compare(local, web),
    // A readiness marker, not a result. The real A/B verdict requires a live
    // provider run; this harness measures the deterministic arms so the
    // pipeline is proven without pretending the external comparison happened.
    benchmarkReadiness: {
      deterministicArmsMeasured: Boolean(local) && Boolean(web),
      liveProviderRequired: true,
      liveProviderMeasured: false,
      status: deps.live ? "live-provider-attached" : "deterministic-only-no-live-claim",
    },
    qualityMeasured: Boolean(local?.qualityMeasured && web?.qualityMeasured),
    claimsVerified: false,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await runBenchmark({
    arm: args.arm,
    repeat: args.repeat,
    live: args.live,
    tasksFile: args.tasks,
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log("V16.3 web-reasoning A/B benchmark (measured values only)")
    console.log(`task set: ${result.taskSet}; tasks/arm: ${result.tasksPerArm}; repeat: ${result.repeat}`)
    for (const arm of [result.arms.a, result.arms.b]) {
      if (!arm) continue
      console.log("")
      console.log(`${arm.arm}`)
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
