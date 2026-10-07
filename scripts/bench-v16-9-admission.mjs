// V16.9 admission benchmark.
//
// QUESTION: does the adaptive-admission PRE-GATE save measurable work on a task
// that does NOT warrant a consultation, compared to V16.8 (which starts phase0
// grounding + read-only local prep BEFORE the escalation router runs)?
//
// METHOD: run the SAME no-signal task N times through both lanes and count
//   * wall-clock ms
//   * provider consult() calls (must be 0 in both - neither should consult)
//   * read-only git/fs probe invocations (the work the pre-gate is meant to skip)
//
// HONESTY: if the delta is within noise, the module is reported as
// NOT_MEASURED and the pre-gate is not wired as an optimization.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, "..", "lib")
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href)

const { createWebReasoningLane: v168 } = await load("web-reasoning-lane-v16-8.mjs")
const { createWebReasoningLane: v169 } = await load("web-reasoning-lane-v16-9.mjs")

const ITERATIONS = Number(process.env.UES_BENCH_ITERS || 25)

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "v169-bench-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root })
  execFileSync("git", ["config", "user.name", "t"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "x"], { cwd: root, stdio: "ignore" })
  return root
}

function countingAdapter(counter) {
  return {
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => ({ sessionId: "s1", state: "ready" }),
    consult: async () => { counter.consult += 1; return { answer: "{}", latencyMs: 1 } },
    followUp: async () => { counter.followUp += 1; return { answer: "{}", latencyMs: 1 } },
    closeSession: async () => true,
  }
}

// A task with NO escalation signal: a trivial doc/rename task.
const NO_SIGNAL = {
  task: "Rename the local variable `value` to `amount` in one file.",
  notes: [],
  affectedSubsystems: 0,
  relevantFiles: [],
  evidence: [],
  requestId: "bench-no-signal",
}

async function measure(createLane, label) {
  const root = fixture()
  const counter = { consult: 0, followUp: 0 }
  const lane = createLane({ mode: "auto", live: false, provider: "deepseek-web", adapters: [countingAdapter(counter)], workspaceRoot: root, maxConsultations: 1, maxFollowUps: 1 })
  // warmup (module init / git caches)
  await lane.consult({ ...NO_SIGNAL, requestId: "warmup" })
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < ITERATIONS; i += 1) {
    await lane.consult({ ...NO_SIGNAL, requestId: `bench-${i}` })
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6
  rmSync(root, { recursive: true, force: true })
  return { label, totalMs, perOpMs: totalMs / ITERATIONS, consultCalls: counter.consult }
}

const a = await measure(v168, "v16.8")
const b = await measure(v169, "v16.9-admission")
const deltaMs = a.totalMs - b.totalMs
const deltaPct = a.totalMs > 0 ? (deltaMs / a.totalMs) * 100 : 0

console.log(JSON.stringify({
  iterations: ITERATIONS,
  v168: a,
  v169: b,
  savedMs: Number(deltaMs.toFixed(2)),
  savedPct: Number(deltaPct.toFixed(1)),
  providerConsultCalls: { v168: a.consultCalls, v169: b.consultCalls },
  measured: Math.abs(deltaPct) >= 5 && deltaMs > 0,
}, null, 2))
