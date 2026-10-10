// V16.17 (§1, §5) PREPARED-EXECUTION PRODUCTION PATH: prepare once → prewarm +
// run consume the SAME canonical descriptor, with the correctness-sensitive
// fencing env inside that descriptor.
//
// The defect (post-tag semantic audit of v16.17.0): `runAgentRpc` built
// `preparedExecution = prepareAgentExecution({...})` but then called
// `RPC_POOL.run(workerKey, { command, args, cwd, env }, ...)` with a SEPARATELY
// hand-built spec literal. The prewarm path (`predictStructuredPrewarmIdentity`)
// prepared through the canonical builder, so the two descriptors drifted and a
// prewarmed worker was never actually consumable. This file drives the REAL
// shipped `executeStructuredPlan` (type-stripped from pi/extensions/ues.ts, the
// SAME production function `ues_execute` calls) and intercepts the REAL
// `PiRpcWorkerPool.prototype.run`/`.prewarm` to prove:
//   - the run hands the pool the ONE frozen prepared spec (not a literal),
//   - that spec carries every correctness-sensitive `UES_CHILD_*` fencing key,
//   - the run reached the real RPC path with a real cwd (writer/read task).
//
// Pre-fix the spec passed to `run` was an unfrozen `{ command, args, cwd, env }`
// literal with NO `UES_CHILD_EXECUTION_OWNER_*` fence, and (because of the
// separate `scope.original` double-wrap defect) the child ran with an undefined
// cwd. Post-fix the spec IS the prepared descriptor and the child has a cwd.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  PiRpcWorkerPool,
  RPC_WORKER_FENCE_ENV_KEYS,
} from "../lib/pi-rpc-pool.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-17-prepared-production-probe")

// `typebox` is a Pi-host dependency absent from the test environment; the
// extension only uses `Type.Object(...)` for tool parameter SCHEMAS, which are
// irrelevant to the RPC child path. A recursive Proxy stub satisfies every
// schema expression without changing behavior under test.
const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n")

// A capture shim installed on the REAL pool prototype. It records what the
// production code actually hands the pool, then returns an honest PASS-shaped
// RPC result without spawning a real Pi process.
function installCapture(capture) {
  const originalRun = PiRpcWorkerPool.prototype.run
  const originalPrewarm = PiRpcWorkerPool.prototype.prewarm
  PiRpcWorkerPool.prototype.run = async function (key, spec, message, options) {
    capture.run.push({ key, spec, options })
    return {
      message: { role: "assistant", content: [{ type: "text", text: "UES_VERDICT: PASS" }], stopReason: "stop" },
      stderr: "",
      toolCalls: 0,
      toolNames: [],
      workerReused: false,
      verdict: "PASS",
      exitCode: 0,
    }
  }
  PiRpcWorkerPool.prototype.prewarm = async function (key, spec) {
    capture.prewarm.push({ key, spec })
    return { key, reused: false, prewarmed: true }
  }
  return () => {
    PiRpcWorkerPool.prototype.run = originalRun
    PiRpcWorkerPool.prototype.prewarm = originalPrewarm
  }
}

let booted = null

async function bootShippedExtension() {
  if (booted) return booted
  const probe = path.join(path.dirname(EXTENSION), `__v1617_prepared_probe_${process.pid}.mjs`)
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs")
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(stub, TYPEBOX_STUB, "utf8")
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    })
    const stubUrl = pathToFileURL(stub).href
    source = source
      .replaceAll('from "typebox"', `from "${stubUrl}"`)
      .replaceAll("from 'typebox'", `from '${stubUrl}'`)
    // Capture the ONE prepared descriptor per child so we can prove the run
    // consumes it by reference (prepare-once), not a hand-built duplicate.
    const marker = "const workerKey = preparedExecution.key;"
    assert.ok(source.includes(marker), "prepared-execution capture marker must exist")
    source = source.replace(
      marker,
      `${marker}\n  (globalThis.__UES_PREPARED = globalThis.__UES_PREPARED || []).push(preparedExecution);`,
    )
    writeFileSync(probe, source, "utf8")
    try {
      booted = { module: await import(pathToFileURL(probe).href) }
      return booted
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

function readTaskPlan(goal) {
  return {
    schemaVersion: 1,
    goal,
    tasks: [
      {
        id: "t1",
        title: "read-only inspection",
        summary: "inspect the repository without mutation",
        risk: "low",
        acceptance: ["inspection completes"],
        verification: ["inspection recorded"],
        dependsOn: [],
        files: { read: ["README.md"] },
      },
    ],
  }
}

test("V16.17 §1/§5: the run consumes the ONE prepared descriptor (frozen), not a spec literal", async () => {
  const { module } = await bootShippedExtension()
  const capture = { run: [], prewarm: [] }
  const restore = installCapture(capture)
  const previousRuntime = process.env.UES_CHILD_RUNTIME
  process.env.UES_CHILD_RUNTIME = "rpc"
  globalThis.__UES_PREPARED = []
  try {
    const result = await module.executeStructuredPlan({
      plan: readTaskPlan("V16.17 §5 prepare-once production"),
      root: ROOT,
      maxAttempts: 1,
      traceID: `v16-17-b5-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 300_000,
      rootPolicy: {},
    })
    assert.equal(result.passed, true, "a valid structured plan must complete on the real RPC path")
  } finally {
    restore()
    if (previousRuntime === undefined) delete process.env.UES_CHILD_RUNTIME
    else process.env.UES_CHILD_RUNTIME = previousRuntime
  }

  assert.ok(capture.run.length >= 1, "the real structured path must reach RPC_POOL.run")

  const preparedDescriptors = globalThis.__UES_PREPARED
  assert.ok(Array.isArray(preparedDescriptors) && preparedDescriptors.length >= 1,
    "runAgentRpc must build at least one prepared descriptor")

  for (const call of capture.run) {
    // The canonical prepared spec is deep-frozen by prepareAgentExecution. A
    // hand-built `{ command, args, cwd, env }` literal is NOT frozen, so this
    // is the behavioral discriminator for "the run consumed the prepared spec".
    assert.ok(Object.isFrozen(call.spec), "the run must hand the pool the FROZEN prepared spec")
    assert.ok(Object.isFrozen(call.spec.args), "the prepared spec's args must be frozen")

    // The run's key identifies the prepared descriptor it must have consumed.
    const prepared = preparedDescriptors.find((row) => row && row.key === call.key)
    assert.ok(prepared, "every run key must correspond to a prepared descriptor")
    assert.equal(call.spec, prepared.spec,
      "the run must consume THE prepared descriptor's spec by reference (prepare once)")
  }
})

test("V16.17 §5: the prepared run spec carries every correctness-sensitive fencing env key", async () => {
  const { module } = await bootShippedExtension()
  const capture = { run: [], prewarm: [] }
  const restore = installCapture(capture)
  const previousRuntime = process.env.UES_CHILD_RUNTIME
  process.env.UES_CHILD_RUNTIME = "rpc"
  try {
    const result = await module.executeStructuredPlan({
      plan: readTaskPlan("V16.17 §5 fencing env production"),
      root: ROOT,
      maxAttempts: 1,
      traceID: `v16-17-b5-fence-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 300_000,
      rootPolicy: {},
    })
    assert.equal(result.passed, true)
  } finally {
    restore()
    if (previousRuntime === undefined) delete process.env.UES_CHILD_RUNTIME
    else process.env.UES_CHILD_RUNTIME = previousRuntime
  }

  assert.ok(capture.run.length >= 1)
  const spec = capture.run[0].spec
  for (const key of RPC_WORKER_FENCE_ENV_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(spec.env, key),
      `the run spec env must carry the fencing key ${key}`)
  }
  // The ownership fence is REAL: a deterministic owner token/scope derived
  // from (root, runtimeEpochId, runId) — never empty.
  assert.match(String(spec.env.UES_CHILD_EXECUTION_OWNER_TOKEN), /^owner:sha256:/,
    "the run must carry a real execution-owner token")
  assert.ok(String(spec.env.UES_CHILD_EXECUTION_OWNER_SCOPE).includes(`::run::${`v16-17-b5-fence-${process.pid}`}`),
    "the ownership scope must be bound to THIS run id")
  assert.equal(spec.env.UES_CHILD_RUN_ID, `v16-17-b5-fence-${process.pid}`)
  assert.equal(spec.env.UES_CHILD_OWNERSHIP_ROOT.length > 0, true)
})

test("V16.17 §5: the delegated child receives the prepared item (real cwd + write scope)", async () => {
  const { module } = await bootShippedExtension()
  const capture = { run: [], prewarm: [] }
  const restore = installCapture(capture)
  const previousRuntime = process.env.UES_CHILD_RUNTIME
  process.env.UES_CHILD_RUNTIME = "rpc"
  try {
    const result = await module.executeStructuredPlan({
      plan: readTaskPlan("V16.17 §5 delegated item production"),
      root: ROOT,
      maxAttempts: 1,
      traceID: `v16-17-b5-item-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 300_000,
      rootPolicy: {},
    })
    assert.equal(result.passed, true,
      "the delegated child must receive the prepared item so it has a real cwd (pre-fix: undefined cwd)")
  } finally {
    restore()
    if (previousRuntime === undefined) delete process.env.UES_CHILD_RUNTIME
    else process.env.UES_CHILD_RUNTIME = previousRuntime
  }
  // A real cwd in the spec is the observable consequence of handing
  // runPreparedChild the prepared item rather than the wave-scope wrapper.
  assert.ok(capture.run.length >= 1)
  for (const call of capture.run) {
    assert.equal(typeof call.spec.cwd, "string")
    assert.ok(call.spec.cwd.length > 0, "the RPC worker spec must have a real cwd")
  }
})

// V16.17 (§3, §9) RUN DEADLINE ON THE REAL PATH. The deadline must be enforced
// during execution (before the first expensive effect) and must bound every
// child timeout. When the deadline has passed, required verification has NOT
// run: the run must return an honest TIMED_OUT/BLOCKED with NO child spawned
// and NO PASS claimed.
test("V16.17 §9 production: an expired run deadline refuses the wave before any child spawn (no PASS)", async () => {
  const { module } = await bootShippedExtension()
  const capture = { run: [], prewarm: [] }
  const restore = installCapture(capture)
  const previousRuntime = process.env.UES_CHILD_RUNTIME
  process.env.UES_CHILD_RUNTIME = "rpc"
  try {
    const result = await module.executeStructuredPlan({
      plan: readTaskPlan("V16.17 §9 expired deadline production"),
      root: ROOT,
      maxAttempts: 1,
      traceID: `v16-17-b3-expired-${process.pid}`,
      // A run that started 60s ago with a 1s wall-clock budget is already over.
      runStartedAt: Date.now() - 60_000,
      runWallClockMs: 1_000,
      rootPolicy: {},
    })
    assert.equal(result.passed, false, "an expired deadline must never claim PASS")
    assert.equal(result.timedOut, true)
    assert.equal(result.reason, "run-deadline-exhausted")
  } finally {
    restore()
    if (previousRuntime === undefined) delete process.env.UES_CHILD_RUNTIME
    else process.env.UES_CHILD_RUNTIME = previousRuntime
  }
  // No child was spawned: the gate fired before the first expensive effect.
  assert.equal(capture.run.length, 0, "an expired deadline must not spawn any child")
})

test("V16.17 §9 production: the child timeout is clamped to the run's remaining wall-clock time", async () => {
  const { module } = await bootShippedExtension()
  const capture = { run: [], prewarm: [] }
  const restore = installCapture(capture)
  const previousRuntime = process.env.UES_CHILD_RUNTIME
  process.env.UES_CHILD_RUNTIME = "rpc"
  try {
    const result = await module.executeStructuredPlan({
      plan: readTaskPlan("V16.17 §9 child timeout clamp production"),
      root: ROOT,
      maxAttempts: 1,
      traceID: `v16-17-b3-clamp-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 5_000,
      rootPolicy: {},
    })
    assert.equal(result.passed, true)
  } finally {
    restore()
    if (previousRuntime === undefined) delete process.env.UES_CHILD_RUNTIME
    else process.env.UES_CHILD_RUNTIME = previousRuntime
  }
  assert.ok(capture.run.length >= 1)
  for (const call of capture.run) {
    // The policy child timeout is 600_000ms; with a 5s run deadline every
    // child timeout must be clamped far below it, and always >= 1ms.
    assert.ok(Number.isFinite(call.options?.hardTimeoutMs), "hardTimeoutMs must be finite")
    assert.ok(call.options.hardTimeoutMs >= 1)
    assert.ok(call.options.hardTimeoutMs <= 5_000, "the child timeout must not exceed the run's remaining time")
    assert.equal(call.options.absoluteHardTimeoutMs, call.options.hardTimeoutMs)
  }
})
