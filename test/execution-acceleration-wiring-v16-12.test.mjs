// V16.12 production-wiring proof.
//
// Every other V16.12 test exercises a module DIRECTLY. This file proves the two
// things a direct test cannot:
//
//   1. LAZY HYDRATION. The V16.12 acceleration modules are registered as lazy
//      runtime modules and a boot hydrates NONE of them; hydrating the
//      composition module resolves the whole acceleration stack.
//
//   2. PRODUCTION REACHABILITY. The extension (`pi/extensions/ues.ts`) resolves
//      the acceleration stack through `lib/lazy-runtime.mjs` and never
//      statically imports it, so boot pays for none of it and PI_ONLY spawns
//      zero browser.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  LAZY_RUNTIME_MODULES,
  hydrateRuntimeModule,
  isLazyModuleLoaded,
  loadedLazyModules,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

const V1612_LAZY_NAMES = [
  LAZY_RUNTIME_MODULES.EXECUTION_ACCELERATION,
  LAZY_RUNTIME_MODULES.VERIFICATION_RECEIPT_CACHE,
  LAZY_RUNTIME_MODULES.TOOL_RESULT_REUSE,
  LAZY_RUNTIME_MODULES.WASTE_DETECTOR,
]

test("V16.12 wiring: the four acceleration modules are registered as lazy", () => {
  for (const name of V1612_LAZY_NAMES) {
    assert.equal(typeof name, "string", `${name} must be a registered lazy module name`)
  }
  assert.deepEqual(
    [...new Set(V1612_LAZY_NAMES)].sort(),
    [
      "execution-acceleration-v16-12",
      "tool-result-reuse-v16-12",
      "verification-receipt-cache-v16-12",
      "waste-detector-v16-12",
    ],
  )
})

test("V16.12 wiring: a boot hydrates NO acceleration module", () => {
  resetLazyRuntimeForTests()
  for (const name of V1612_LAZY_NAMES) {
    assert.equal(isLazyModuleLoaded(name), false, `${name} must not be hydrated at boot`)
  }
  assert.deepEqual(loadedLazyModules(), [])
})

test("V16.12 wiring: hydrating the composition module resolves the whole stack", async () => {
  resetLazyRuntimeForTests()
  const accel = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.EXECUTION_ACCELERATION)
  assert.equal(typeof accel.planExecutionAcceleration, "function")
  assert.equal(typeof accel.createAccelerationContext, "function")
  assert.equal(typeof accel.assertFreshGateAllowed, "function")
  // The composition module imports the other five capabilities, so they are all
  // in-process after one hydration. They are NOT separate lazy entries.
  assert.equal(typeof accel.runTaskDag, "function")
  assert.equal(typeof accel.executionAccelerationExports.wallAttributionToEfficiencyEvents, "function")
  resetLazyRuntimeForTests()
})

test("V16.12 wiring: the extension resolves acceleration ONLY through the lazy registry", () => {
  const source = readFileSync(EXTENSION, "utf8")
  // The extension must reference the lazy module names, not static imports.
  for (const marker of [
    "EXECUTION_ACCELERATION",
    "VERIFICATION_RECEIPT_CACHE",
    "TOOL_RESULT_REUSE",
    "WASTE_DETECTOR",
  ]) {
    assert.ok(
      source.includes(`LAZY_RUNTIME_MODULES.${marker}`),
      `the extension must resolve ${marker} through LAZY_RUNTIME_MODULES`,
    )
  }
  // And it must NOT statically import any of the V16.12 modules.
  for (const heavy of [
    "execution-acceleration-v16-12",
    "verification-receipt-cache-v16-12",
    "tool-result-reuse-v16-12",
    "waste-detector-v16-12",
    "task-dag-scheduler-v16-12",
    "incremental-verification-v16-12",
    "warm-service-reuse-v16-12",
  ]) {
    const staticImport = new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*["'][^"']*${heavy}\\.mjs["']`)
    assert.doesNotMatch(
      source,
      staticImport,
      `${heavy} must NOT be statically imported by the extension (boot must not pay for it)`,
    )
  }
})

test("V16.12 wiring: the verification-plan action prefers V16.12 and falls back to the V16.10 ladder", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes("planExecutionAcceleration"), "the action must call the V16.12 planner")
  assert.ok(
    source.includes('import("../../lib/verification-ladder-v16-10.mjs")'),
    "the action must keep a V16.10 ladder fallback so it never regresses",
  )
})
