// V16.16 Cold Start: tiny tasks hydrate nothing unrelated.
//
// A trivial local task must reach edit + targeted verify without paying for
// the browser, DeepSeek, research or parallel stacks. These tests prove the
// wiring (lazy registry + no static imports), while the benchmark measures
// the real wall times with honest provenance.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  LAZY_RUNTIME_MODULES,
  LAZY_RUNTIME_STACKS,
  hydrateRuntimeModule,
  isLazyModuleLoaded,
  loadedLazyModules,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.16 cold start: a fresh process hydrates nothing", () => {
  resetLazyRuntimeForTests()
  assert.deepEqual(loadedLazyModules(), [])
  for (const name of [
    LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER,
    LAZY_RUNTIME_MODULES.WEB_REASONING_LANE,
    LAZY_RUNTIME_MODULES.BROWSER_LANE,
    LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME,
    LAZY_RUNTIME_MODULES.RESEARCH_BROKER,
  ]) {
    assert.equal(isLazyModuleLoaded(name), false)
  }
})

test("V16.16 cold start: hydrating one stack never pulls an unrelated stack", async () => {
  resetLazyRuntimeForTests()
  await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME)
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME), true)
  // The parallel stack pulls its own four owners through the composition's
  // static imports (one cached hydration), but never the advisor, browser or
  // research stacks.
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER), false)
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.WEB_REASONING_LANE), false)
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.BROWSER_LANE), false)
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.RESEARCH_BROKER), false)
  resetLazyRuntimeForTests()
})

test("V16.16 cold start: the controller never statically imports heavy or V16.16 modules", () => {
  const text = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8")
  for (const forbidden of [
    "lib/deepseek-web-adapter.mjs",
    "lib/web-reasoning-lane-v16-9.mjs",
    "lib/browser-lane.mjs",
    "lib/parallel-coding-runtime-v16-15.mjs",
    "lib/parallel-execution-policy-v16-15.mjs",
    "lib/execution-conflict-graph-v16-15.mjs",
    "lib/wave-shared-context-v16-15.mjs",
    "lib/integration-transaction-v16-15.mjs",
    "lib/critical-path-history-v16-16.mjs",
    "lib/external-research-broker-v16-13.mjs",
  ]) {
    assert.ok(!text.includes(`from "../../${forbidden}"`), `ues.ts statically imports ${forbidden}`)
  }
  // The async git runner reaches the controller only through the sandbox
  // owner (lib -> lib), never as a controller-level static import.
  assert.ok(!text.includes("git-async-runtime"), "ues.ts must not import the git runner directly")
})

test("V16.16 cold start: the parallel stack stays lazy behind one registry entry", () => {
  assert.ok(LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME))
  assert.ok(LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(LAZY_RUNTIME_MODULES.PARALLEL_EXECUTION_POLICY))
  assert.ok(LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(LAZY_RUNTIME_MODULES.EXECUTION_CONFLICT_GRAPH))
  assert.ok(LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(LAZY_RUNTIME_MODULES.WAVE_SHARED_CONTEXT))
  assert.ok(LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(LAZY_RUNTIME_MODULES.INTEGRATION_TRANSACTION))
  resetLazyRuntimeForTests()
})
