// V16.15 single-shot parallel coding PRODUCTION WIRING.
//
// The owner suites prove the policy, the conflict graph, the wave context and
// the integration transaction are correct. This suite proves the CONTROLLER
// actually uses them, because a correct module that nothing calls changes
// nothing.
//
// It checks the shipped `pi/extensions/ues.ts` textually AND behaviorally:
//   * the composition entry point is reached through the LAZY runtime, so boot
//     still pays for none of the V16.15 stack;
//   * the wave decision really drives concurrency instead of a second ad-hoc
//     formula;
//   * a wave's children really receive the shared snapshot through a delta;
//   * the integration loop really goes through the transaction, and the proven
//     V16.5 loop is still the fallback when the stack cannot hydrate;
//   * the terminal state really comes from the ONE completion owner.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { LAZY_RUNTIME_MODULES, LAZY_RUNTIME_STACKS } from "../lib/lazy-runtime.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

const source = () => readFileSync(EXTENSION, "utf8")

test("V16.15 wiring: the controller reaches the runtime through the LAZY registry", () => {
  const text = source()
  // Never a static import: boot must not pay for the V16.15 stack.
  assert.ok(!/from "\.\.\/\.\.\/lib\/parallel-coding-runtime-v16-15\.mjs"/.test(text), "the composition must not be statically imported")
  assert.ok(!/from "\.\.\/\.\.\/lib\/parallel-execution-policy-v16-15\.mjs"/.test(text), "the policy must not be statically imported")
  assert.ok(!/from "\.\.\/\.\.\/lib\/execution-conflict-graph-v16-15\.mjs"/.test(text), "the conflict graph must not be statically imported")
  assert.ok(!/from "\.\.\/\.\.\/lib\/wave-shared-context-v16-15\.mjs"/.test(text), "the wave context must not be statically imported")
  assert.ok(!/from "\.\.\/\.\.\/lib\/integration-transaction-v16-15\.mjs"/.test(text), "the integration transaction must not be statically imported")

  assert.ok(
    text.includes("const loadParallelCodingRuntimeModule = () => hydrateLazy(LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME)"),
    "the composition accessor is missing",
  )
  assert.ok(text.includes("await loadParallelCodingRuntimeModule()"), "the composition is never hydrated")
})

test("V16.15 wiring: the ONE wave decision drives concurrency", () => {
  const text = source()
  assert.ok(text.includes("const wavePlan = wavePlanModule"), "the wave plan is never computed")
  assert.ok(text.includes("wavePlanModule.planWave({"), "the controller does not ask the policy owner")
  assert.ok(text.includes("const waveConcurrency = wavePlan"), "the plan does not drive the wave concurrency")
  // The plan's concurrency is still clamped by the pre-existing V16.5 fleet bound,
  // so a policy change can never widen the shipped budget by itself.
  assert.ok(
    text.includes("Math.max(1, Math.min(fleetBound, Number(wavePlan.concurrency) || 1))"),
    "the plan concurrency is not clamped by the V16.5 fleet bound",
  )
  // A failed hydration must never be a reason to parallelize.
  assert.ok(text.includes(": fleetBound;"), "the fail-safe fallback bound is missing")
  assert.ok(text.includes('const wavePosture = wavePlan?.posture || "SERIAL_STRUCTURED"'), "the fail-safe posture is missing")
})

test("V16.15 wiring: the wave plan is given the declared scopes, not a guess", () => {
  const text = source()
  assert.ok(text.includes("wavePlanModule.planWave({"), "no wave plan call")
  for (const marker of [
    "readOnly: item.writeFiles.length === 0",
    "writeFiles: item.writeFiles",
    "readFiles: taskReadFiles(item.task)",
  ]) {
    assert.ok(text.includes(marker), `the declared scope is not passed: ${marker}`)
  }
  // A declared read file list is the input that lets the conflict graph prove a
  // read/write dependency instead of assuming one.
  assert.ok(text.includes("taskReadFiles"), "declared read files are never used")
})

test("V16.15 wiring: every child of a wave receives the shared snapshot as a delta", () => {
  const text = source()
  assert.ok(text.includes("wavePlanModule.buildWaveSnapshot({"), "no shared snapshot is built")
  assert.ok(text.includes("wavePlanModule.buildChildDelta({"), "no child delta is built")
  assert.ok(text.includes("waveDeltas.get(String(item.task.id))?.text"), "the child delta never reaches the child prompt")
  // The snapshot is built once per wave, NOT once per child.
  const snapshotCalls = text.split("wavePlanModule.buildWaveSnapshot({").length - 1
  assert.equal(snapshotCalls, 1, `expected exactly one snapshot build site, found ${snapshotCalls}`)
  // Accounting is measured, and it is recorded for the run report.
  assert.ok(text.includes("wavePlanModule.waveAccounting({"), "wave accounting is never computed")
  assert.ok(text.includes("parallelCodingTelemetry.sharedContext.push({"), "wave accounting is never recorded")
})

test("V16.15 wiring: integration goes through the transaction and keeps the V16.5 fallback", () => {
  const text = source()
  assert.ok(text.includes("wavePlanModule.runIntegration({"), "the controller does not use the integration transaction")
  // The fallback loop must still exist: a missing module is not a licence to
  // apply patches with no preflight.
  assert.ok(text.includes("const receipt = await integrateTaskSandbox(input.root, item.sandbox.dir, { keep: true })"), "the V16.5 fallback integration loop was removed")
  assert.ok(text.includes("await rollbackTaskSandbox("), "the V16.5 fallback rollback was removed")
  // The transaction outcome vocabulary comes from the owner, never a local literal.
  assert.ok(text.includes("wavePlanModule.INTEGRATION_OUTCOME.INTEGRATED"), "the integration outcome is compared against a local literal")
  assert.ok(text.includes("parallelCodingTelemetry.integrationTransactions.push({"), "the transaction result is never recorded")
})

test("V16.15 wiring: the terminal state comes from the ONE completion owner", () => {
  const text = source()
  assert.ok(text.includes("completionModule.completionDecision({"), "the controller never asks the completion owner")
  assert.ok(text.includes("parallelCodingTelemetry.completion ="), "the completion decision is never recorded")
})

test("V16.15 wiring: no wave receipt can be read as a PASS", () => {
  const text = source()
  // The telemetry surface pins the honesty field, so a consumer that reads the
  // schedule report cannot mistake a parallel decision for a verification.
  assert.ok(text.includes("canProduceVerdict: false"), "the wave telemetry does not pin canProduceVerdict")
  const module = readFileSync(path.join(ROOT, "lib", "parallel-coding-runtime-v16-15.mjs"), "utf8")
  // The composition itself must never claim a verdict anywhere.
  assert.ok(!/canProduceVerdict:\s*true/.test(module), "the composition must never claim a verdict")
  assert.ok(!/verdict:\s*"PASS"/.test(module), "the composition must never synthesize a PASS")
})

test("V16.15 wiring: the bounded loop governor asks the owners before retrying", () => {
  const text = source()
  // The loop must consult BOTH owners, and it must not re-derive either rule.
  assert.ok(text.includes("module.retryDecision({"), "the retry owner is never consulted")
  assert.ok(text.includes("module.progressWatchdog({"), "the progress owner is never consulted")
  assert.ok(text.includes("parallelCodingTelemetry.retries.push("), "the loop decision is never recorded")
  // Every retry site must go through the governor: a raw `attempt < maxAttempts`
  // retry would silently bypass both owners.
  const rawRetries = text.split("if (attempt < input.maxAttempts) continue;").length - 1
  assert.equal(rawRetries, 0, `a retry site bypasses the governor (${rawRetries} found)`)
  const governed = text.split("governWaveLoop(wavePlanModule, waveIndex, ids,").length - 1
  assert.equal(governed, 3, `expected 3 governed retry sites, found ${governed}`)
  // A missing module must preserve the pre-V16.15 bounded-attempt behavior.
  assert.ok(
    text.includes("const retryAllowed = retry ? retry.retry === true : attemptsLeft"),
    "the fail-safe fallback to the bounded attempt budget is missing",
  )
  // A retry decision is loop control, never a verdict.
  const governorBlock = text.slice(text.indexOf("const governWaveLoop = ("), text.indexOf("for (let waveIndex = 0"));
  assert.ok(governorBlock.includes("canProduceVerdict: false"), "the loop decision does not pin canProduceVerdict")
  assert.ok(!/canProduceVerdict:\s*true/.test(governorBlock), "the loop decision claims a verdict")
})

test("V16.15 wiring: the V16.15 stack is registered lazily and hydrates on demand", async () => {
  const lazy = await import("../lib/lazy-runtime.mjs")
  lazy.resetLazyRuntimeForTests()

  // Cold: nothing loaded.
  assert.deepEqual(lazy.loadedLazyModules(), [])

  // A TINY parent-direct task must be answerable from the policy owner alone.
  const policy = await lazy.hydrateRuntimeModule(LAZY_RUNTIME_MODULES.PARALLEL_EXECUTION_POLICY)
  const tiny = policy.decideParallelExecution({
    changedFiles: ["lib/one.mjs"],
    scopes: [{ id: "t1", readOnly: false, writeFiles: ["lib/one.mjs"] }],
  })
  assert.equal(tiny.posture, "PARENT_DIRECT")
  assert.equal(tiny.spawnsChildren, false)
  // Hydrating one owner must not drag in the rest of the stack.
  assert.deepEqual(lazy.loadedLazyModules(), [LAZY_RUNTIME_MODULES.PARALLEL_EXECUTION_POLICY])

  // The full stack hydrates completely when a wave really needs it.
  lazy.resetLazyRuntimeForTests()
  const stack = await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING)
  assert.equal(Object.keys(stack).length, lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING.length)
  for (const name of lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING) {
    assert.equal(lazy.isLazyModuleLoaded(name), true, `${name} did not hydrate`)
  }

  lazy.resetLazyRuntimeForTests()
})
