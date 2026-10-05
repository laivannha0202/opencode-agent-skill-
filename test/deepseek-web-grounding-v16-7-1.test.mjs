// V16.7.1 P0 regression: primary-consultation grounding starvation.
//
// The defect: the primary `webLane.consult()` call passed ONLY
// task/notes/constraints/verification/affectedSubsystems. It never passed
// `knownFiles` or `relevantFiles`, so `packetInputFrom()` produced
// `knownFiles: []` and `buildDecisionPacket()` produced zero RELEVANT_FILES
// (`packetFiles: 0`). The local verifier then had NOTHING to bind a DeepSeek
// claim against, so EVERY otherwise-valid answer was rejected as
// `no-local-grounding` and the chain ended in `advisorText: null`. DeepSeek was
// wired in, authenticated and reachable -- and completely unable to advise.
//
// This file proves the fix the way production runs it, NOT by calling
// `verifyLocalAdvice()` in isolation:
//
//   1. The SHIPPED extension is type-stripped and really imported (boot proof).
//   2. `buildPrimaryConsultGrounding` -- the SAME exported function the
//      controller calls at the consult site -- builds the capsule from a real
//      plan shape (`{schemaVersion, goal, tasks[]}`), a real task string and a
//      real changed-file set.
//   3. The lane is hydrated through the REAL lazy-runtime registry, then built
//      exactly as `createRunWebLane()` builds it.
//   4. `consult()` is called with that grounding, exactly as the controller now
//      does, against a READY provider fixture.
//   5. The chain is asserted to reach `packetFiles > 0`, bind the claim PRESENT,
//      ACCEPT the advice and end in a NON-EMPTY `advisorText`.
//   6. The OPPOSITE case (a claim on a file that is NOT in the local set) is
//      asserted to be REJECTED, so the fix did not simply make everything pass.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

// ---------------------------------------------------------------------------
// Boot the SHIPPED extension (same technique the sibling wiring test uses).
// ---------------------------------------------------------------------------
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-7-1-grounding-probe")
const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n")

let bootResult = null
async function bootShippedExtension() {
  if (bootResult) return bootResult
  const probe = path.join(path.dirname(EXTENSION), `__v1671_grounding_probe_${process.pid}.mjs`)
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs")
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(stub, TYPEBOX_STUB, "utf8")
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    })
    const stubUrl = pathToFileURL(stub).href
    source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`)
    writeFileSync(probe, source, "utf8")
    try {
      const module = await import(pathToFileURL(probe).href)
      bootResult = { module, source }
      return bootResult
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// A READY provider double implementing the real WebReasoningProvider surface.
// ---------------------------------------------------------------------------
function readyProvider(advice) {
  const calls = { capability: 0, startSession: 0, consult: 0, closeSession: 0 }
  return {
    calls,
    adapter: {
      id: "deepseek-web",
      capability: async () => {
        calls.capability += 1
        return { state: "ready", reason: "ready", supportsFollowUp: true }
      },
      startSession: async () => {
        calls.startSession += 1
        return { sessionId: "dsw-grounding-1", state: "ready" }
      },
      consult: async () => {
        calls.consult += 1
        return { answer: JSON.stringify(advice) }
      },
      followUp: async () => ({ answer: JSON.stringify(advice) }),
      closeSession: async () => {
        calls.closeSession += 1
        return true
      },
    },
  }
}

async function productionEquivalentLane(adapter) {
  const lazy = await import(pathToFileURL(path.join(ROOT, "lib", "lazy-runtime.mjs")).href)
  const laneModule = await lazy.hydrateRuntimeModule(lazy.LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
  assert.equal(typeof laneModule.createWebReasoningLane, "function")
  return laneModule.createWebReasoningLane({
    mode: "auto",
    live: false,
    provider: "deepseek-web",
    maxConsultations: 1,
    maxFollowUps: 1,
    adapters: [adapter],
  })
}

// A REAL plan shape. Files live under `tasks[].files`, never top-level -- the
// follow-up path's old `structuredPlan.files` read was ALWAYS empty because of
// exactly this shape.
//
// V16.7.1 Part 1: every path below is a REAL file in this repository, because
// `localGroundingForConsult` now verifies each candidate against the filesystem
// AND the repository boundary before it can enter `knownFiles`. A hallucinated
// path is dropped, never bound PRESENT.
const REAL_PLAN = {
  schemaVersion: 1,
  goal: "Make the browser lane re-resolve the target before a single retry.",
  tasks: [
    {
      id: "task-01",
      title: "Compare identity before retry",
      summary: "The gate records the fingerprint but never compares it.",
      dependsOn: [],
      files: {
        create: [],
        modify: ["lib/browser-lane.mjs"],
        test: ["test/v16-3-controller-integration.test.mjs"],
        delete: [],
        read: ["lib/decision-packet.mjs"],
      },
      acceptance: ["A changed test id is re-resolved before retry."],
      verification: ["npm test -- test/v16-3-controller-integration.test.mjs"],
      risk: "medium",
    },
  ],
}

const ADVICE_GROUNDED = {
  summary: "The stale click path re-resolves without an identity comparison.",
  hypotheses: ["The gate records the target fingerprint but never compares it."],
  recommendedApproach: ["Compare identity before permitting the single retry."],
  filesToInspect: ["lib/browser-lane.mjs"],
  risks: ["Over-permissive identity would click the wrong control."],
  edgeCases: ["A control whose test id changes between renders."],
  verificationSuggestions: ["Add a test where the test id changes."],
  confidence: 0.7,
}

const ADVICE_UNGROUNDED = {
  ...ADVICE_GROUNDED,
  summary: "The bug is in a module that does not exist in this repository.",
  filesToInspect: ["lib/this-file-does-not-exist-anywhere.mjs"],
}

// ---------------------------------------------------------------------------
// 1. The shipped grounding builder is exported and produces real paths.
// ---------------------------------------------------------------------------
test("V16.7.1 grounding: the shipped extension exports buildPrimaryConsultGrounding", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(typeof module.buildPrimaryConsultGrounding, "function", "the grounding builder must be exported for regression coverage")
})

test("V16.7.1 grounding: the capsule is truthful, normalized and bounded", async () => {
  const { module } = await bootShippedExtension()
  const grounding = module.buildPrimaryConsultGrounding({
    task: "Fix the retry gate in lib/browser-lane.mjs and add test/v16-3-controller-integration.test.mjs coverage.",
    plan: REAL_PLAN,
    // Part 1: only `lib/browser-lane.mjs` really exists here. The backslash form
    // is normalized and verified; the escape, the absolute path, the empty
    // value AND the nonexistent `src/nested/thing.ts` are all dropped.
    changedFiles: [{ path: ".\\lib\\browser-lane.mjs" }, "src\\nested\\thing.ts", "../escape.mjs", "/abs/path.mjs", ""],
    root: ROOT,
  })

  // Plan scope (all five kinds) + task-referenced + changed, de-duplicated, and
  // each one VERIFIED to exist inside the repository.
  assert.ok(grounding.knownFiles.includes("lib/browser-lane.mjs"))
  assert.ok(grounding.knownFiles.includes("test/v16-3-controller-integration.test.mjs"))
  assert.ok(grounding.knownFiles.includes("lib/decision-packet.mjs"))
  // A path that does NOT exist on disk must never become local truth.
  assert.equal(grounding.knownFiles.includes("src/nested/thing.ts"), false, "a nonexistent path must be dropped")
  assert.ok(grounding.dropped.includes("src/nested/thing.ts"))
  // No escape, no absolute, no empty entry ever survives.
  assert.equal(grounding.knownFiles.some((p) => p.includes("..")), false)
  assert.equal(grounding.knownFiles.some((p) => p.startsWith("/")), false)
  assert.equal(grounding.knownFiles.includes(""), false)
  // Backslashes are normalized to slash form (what the verifier matches on).
  assert.equal(grounding.knownFiles.some((p) => p.includes("\\")), false)
  // relevantFiles mirror knownFiles for the packet, and are bounded.
  assert.deepEqual(grounding.relevantFiles.map((row) => row.path), grounding.knownFiles)
  assert.ok(grounding.knownFiles.length <= 60)
})

test("V16.7.1 grounding: the broken follow-up source is genuinely populated (plan tasks, not plan.files)", async () => {
  const { module } = await bootShippedExtension()
  // The old follow-up read `structuredPlan.files`, which never exists. Feeding
  // the REAL plan shape must now yield the task files.
  const grounding = module.buildPrimaryConsultGrounding({ task: "unrelated wording", plan: REAL_PLAN, root: ROOT })
  assert.ok(grounding.knownFiles.length >= 3, "plan task files must populate the follow-up grounding")
  assert.ok(grounding.knownFiles.includes("lib/browser-lane.mjs"))
})

// ---------------------------------------------------------------------------
// 2. Production-path success: grounding -> packetFiles > 0 -> ACCEPTED advice.
// ---------------------------------------------------------------------------
test("V16.7.1 grounding: primary consult with real grounding reaches packetFiles>0 and a non-empty advisorText", async () => {
  const { module } = await bootShippedExtension()
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()

  const grounding = module.buildPrimaryConsultGrounding({
    task: "The verifier still fails across the browser lane; compare identity before retry.",
    plan: REAL_PLAN,
    changedFiles: ["lib/browser-lane.mjs"],
    root: ROOT,
  })
  assert.ok(grounding.knownFiles.length > 0, "the fix must produce real grounding")

  const { calls, adapter } = readyProvider(ADVICE_GROUNDED)
  const lane = await productionEquivalentLane(adapter)
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane; compare identity before retry.",
    notes: ["pending resume capsule", "failure delta", "advisor packet"].filter(Boolean).join("\n\n"),
    constraints: ["MUST NOT disable verification"],
    verification: ["npm test"],
    affectedSubsystems: 2,
    knownFiles: grounding.knownFiles,
    relevantFiles: grounding.relevantFiles,
    requestId: "grounding-consult-1",
  })

  assert.equal(calls.consult, 1, "a real provider consultation must happen")
  assert.equal(result.consulted, true)
  assert.ok(result.packet.files > 0, `packetFiles must be > 0, got ${result.packet.files}`)
  assert.equal(result.outcome, "advised")
  assert.equal(result.verification.accepted, true, "grounded advice must be accepted")
  assert.ok(result.advisorText && result.advisorText.length > 0, "the chain must end in non-empty advisorText")
  assert.ok(result.advisorText.includes("ADVISORY EVIDENCE ONLY"))
  // The accepted advice is still not a task verdict.
  assert.equal(result.isTaskVerdict, false)
  assert.equal(result.canProducePass, false)
})

test("V16.7.1 grounding: the telemetry the controller journals shows a grounded packet", async () => {
  const { module } = await bootShippedExtension()
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const grounding = module.buildPrimaryConsultGrounding({ task: "The verifier still fails across the browser lane; the root cause is ambiguous.", plan: REAL_PLAN, root: ROOT })
  const { adapter } = readyProvider(ADVICE_GROUNDED)
  const lane = await productionEquivalentLane(adapter)
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane; the root cause is ambiguous and several fixes are plausible.",
    notes: "capsule",
    knownFiles: grounding.knownFiles,
    relevantFiles: grounding.relevantFiles,
  })
  // decisionPacketFiles is the exact counter that was 0 in production.
  assert.ok(result.telemetry.decisionPacketFiles > 0, "decisionPacketFiles must be > 0")
  assert.equal(result.telemetry.localVerificationAccepts, 1)
  assert.equal(result.telemetry.localVerificationRejects, 0)
})

// ---------------------------------------------------------------------------
// 3. The fix is NOT "accept everything": an ungrounded claim is still rejected.
// ---------------------------------------------------------------------------
test("V16.7.1 grounding: advice naming a file OUTSIDE the local set is rejected (advisorText null)", async () => {
  const { module } = await bootShippedExtension()
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const grounding = module.buildPrimaryConsultGrounding({ task: "browser lane retry", plan: REAL_PLAN, root: ROOT })
  const { adapter } = readyProvider(ADVICE_UNGROUNDED)
  const lane = await productionEquivalentLane(adapter)
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane; the root cause is ambiguous and several fixes are plausible.",
    notes: "capsule",
    knownFiles: grounding.knownFiles,
    relevantFiles: grounding.relevantFiles,
  })
  assert.equal(result.consulted, true)
  assert.equal(result.outcome, "advice-rejected", "a claim on a nonexistent file must be rejected")
  assert.equal(result.verification.accepted, false)
  assert.equal(result.advisorText, null, "rejected advice must never reach the executor")
  assert.equal(result.telemetry.localVerificationRejects, 1)
})

test("V16.7.1 grounding: with NO grounding at all the historical starvation still rejects", async () => {
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { adapter } = readyProvider(ADVICE_GROUNDED)
  const lane = await productionEquivalentLane(adapter)
  // This is the EXACT pre-fix call shape: no knownFiles, no relevantFiles.
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane; compare identity before retry.",
    notes: "capsule",
    constraints: ["MUST NOT disable verification"],
    verification: ["npm test"],
    affectedSubsystems: 2,
  })
  // Documents WHY the fix was needed: ungrounded advice is rejected.
  assert.equal(result.outcome, "advice-rejected")
  assert.equal(result.advisorText, null)
  assert.equal(result.packet.files, 0, "the pre-fix call produced an empty packet file set")
})

// ---------------------------------------------------------------------------
// 4. Part 1: real existence + repo-containment. A planner hallucination or an
//    escape must NEVER become local truth.
// ---------------------------------------------------------------------------
test("V16.7.1 grounding Part 1: only real in-repo files enter knownFiles", async () => {
  const { module } = await bootShippedExtension()
  // A disposable repository root that mirrors the required fixture exactly:
  //   src/real.mjs            -> EXISTS
  //   src/does-not-exist.mjs  -> hallucinated
  //   ../outside.mjs          -> escape (outside the root)
  const fixtureRoot = path.join(ROOT, ".ues-cache", `v16-7-1-grounding-fixture-${process.pid}`)
  try {
    mkdirSync(path.join(fixtureRoot, "src"), { recursive: true })
    writeFileSync(path.join(fixtureRoot, "src", "real.mjs"), "export const real = true\n", "utf8")
    // A sibling file OUTSIDE the fixture root that the escape would reach.
    writeFileSync(path.join(fixtureRoot, "..", `outside-${process.pid}.mjs`), "export const outside = true\n", "utf8")
    const grounding = module.buildPrimaryConsultGrounding({
      task: "Inspect src/real.mjs and src/does-not-exist.mjs before acting.",
      changedFiles: ["src/real.mjs", "src/does-not-exist.mjs", "../outside.mjs"],
      root: fixtureRoot,
    })
    assert.deepEqual(grounding.knownFiles, ["src/real.mjs"], "only the real in-repo file may be known")
    assert.equal(grounding.knownFiles.includes("src/does-not-exist.mjs"), false)
    assert.equal(grounding.knownFiles.includes("../outside.mjs"), false)
    assert.equal(grounding.knownFiles.some((p) => p.includes("..")), false)
    // Every candidate that NORMALIZED but failed verification is reported, so
    // the drop is auditable. A `..` escape is rejected one stage earlier (at
    // normalization), so it is absent from `dropped` by design -- it never
    // became a candidate at all.
    assert.ok(grounding.dropped.includes("src/does-not-exist.mjs"))
    assert.equal(grounding.dropped.includes("../outside.mjs"), false, "a `..` escape is rejected at normalization, not as a dropped candidate")
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(path.join(fixtureRoot, "..", `outside-${process.pid}.mjs`), { force: true })
  }
})

test("V16.7.1 grounding Part 1: the SAME fixture driven through plan.tasks[].files is verified", async () => {
  const { module } = await bootShippedExtension()
  // The requirement names `plan.tasks[].files` as a candidate source, so the
  // exact fixture must be proven through THAT path too (not only changedFiles).
  const fixtureRoot = path.join(ROOT, ".ues-cache", `v16-7-1-grounding-plan-fixture-${process.pid}`)
  try {
    mkdirSync(path.join(fixtureRoot, "src"), { recursive: true })
    writeFileSync(path.join(fixtureRoot, "src", "real.mjs"), "export const real = true\n", "utf8")
    writeFileSync(path.join(fixtureRoot, "..", `plan-outside-${process.pid}.mjs`), "export const outside = true\n", "utf8")
    const plan = {
      schemaVersion: 1,
      goal: "Prove plan-task grounding is existence-checked.",
      tasks: [
        {
          id: "task-01",
          title: "Only real files are known",
          dependsOn: [],
          // The array form of `task.files`, carrying the exact required values.
          files: ["src/real.mjs", "src/does-not-exist.mjs", "../outside.mjs"],
          acceptance: [],
          verification: [],
          risk: "low",
        },
      ],
    }
    const grounding = module.buildPrimaryConsultGrounding({ task: "no referenced files here", plan, root: fixtureRoot })
    assert.deepEqual(grounding.knownFiles, ["src/real.mjs"], "plan.tasks[].files must be existence + containment checked")
    assert.equal(grounding.knownFiles.includes("src/does-not-exist.mjs"), false)
    assert.equal(grounding.knownFiles.includes("../outside.mjs"), false)
    assert.equal(grounding.knownFiles.some((p) => p.includes("..")), false)
    assert.ok(grounding.dropped.includes("src/does-not-exist.mjs"))
    assert.equal(grounding.dropped.includes("../outside.mjs"), false, "a `..` escape is rejected at normalization, not as a dropped candidate")
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(path.join(fixtureRoot, "..", `plan-outside-${process.pid}.mjs`), { force: true })
  }
})

test("V16.7.1 grounding Part 1: a DeepSeek claim on a nonexistent plan file is rejected fail-closed", async () => {
  const { module } = await bootShippedExtension()
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  // The plan names a real file AND a hallucinated one; the hallucination is
  // dropped, so an advice that names ONLY it has nothing to bind PRESENT.
  const plan = {
    schemaVersion: 1,
    goal: "Reject a claim on a file that does not exist.",
    tasks: [
      {
        id: "task-01",
        title: "grounding",
        dependsOn: [],
        files: { create: [], modify: ["lib/browser-lane.mjs"], test: [], delete: [], read: [] },
        acceptance: [],
        verification: [],
        risk: "low",
      },
    ],
  }
  const grounding = module.buildPrimaryConsultGrounding({ task: "browser lane retry", plan, root: ROOT })
  assert.ok(grounding.knownFiles.includes("lib/browser-lane.mjs"))
  const adviceOnMissing = { ...ADVICE_GROUNDED, summary: "The fix belongs in a file the planner invented.", filesToInspect: ["src/does-not-exist.mjs"] }
  const { adapter } = readyProvider(adviceOnMissing)
  const lane = await productionEquivalentLane(adapter)
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane; the root cause is ambiguous and several fixes are plausible.",
    notes: "capsule",
    knownFiles: grounding.knownFiles,
    relevantFiles: grounding.relevantFiles,
  })
  assert.equal(result.consulted, true)
  assert.equal(result.outcome, "advice-rejected", "a claim on a nonexistent plan file must be rejected")
  assert.equal(result.advisorText, null)
  assert.equal(result.verification.accepted, false)
})

// ---------------------------------------------------------------------------
// 5. Controller source: the primary consult site really passes grounding.
// ---------------------------------------------------------------------------
test("V16.7.1 grounding source: the primary consult passes knownFiles + relevantFiles", async () => {
  const source = readFileSync(EXTENSION, "utf8")
  // The consult site must spread the grounding capsule into the lane call.
  assert.ok(source.includes("const consultGrounding = localGroundingForConsult("), "the primary consult must build a grounding capsule")
  assert.ok(source.includes("knownFiles: consultGrounding.knownFiles"), "the primary consult must pass knownFiles")
  assert.ok(source.includes("relevantFiles: consultGrounding.relevantFiles"), "the primary consult must pass relevantFiles")
  // The patch review (the second production consult) must be grounded too.
  assert.ok(source.includes("const patchGrounding = localGroundingForConsult("), "the patch review must build a grounding capsule")
  assert.ok(source.includes("knownFiles: patchGrounding.knownFiles"), "the patch review must pass knownFiles")
  // The broken follow-up source (`structuredPlan?.files`) must be gone.
  assert.equal(source.includes("Array.isArray(structuredPlan?.files)"), false, "the nonexistent structuredPlan.files read must be removed")
})
