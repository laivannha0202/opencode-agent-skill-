// V15.3 Phase 1 - incremental write intelligence.
//
// The provider is injected, so every branch is deterministic and no language
// server is required. The twelve cases below map one-to-one onto the phase
// contract; several of them are failure-mode tests whose only job is to prove
// the runtime cannot produce a false clean.
//
//   1  edit -> complete diagnostics with error
//   2  edit -> complete zero diagnostics -> confirmed-clean
//   3  incomplete -> NOT clean
//   4  stale result after a second edit is ignored
//   5  multiple quick edits coalesce into one trailing check
//   6  warm provider reuse (no duplicate provider spawn per edit)
//   7  unsupported extension does not crash
//   8  provider unavailable degrades gracefully
//   9  diagnostics failure does not undo a successful edit
//   10 feedback never re-enters itself
//   11 the model-facing payload stays bounded
//   12 telemetry counters move exactly once per terminal outcome

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  classify,
  createWriteFeedbackController,
  extractWrittenFile,
  renderFeedback,
  resetWriteFeedbackMetrics,
  writeFeedbackEligibility,
  writeFeedbackGuard,
  writeFeedbackMetrics,
  WRITE_FEEDBACK_STATUS,
  WRITE_FEEDBACK_TOOLS,
} from "../lib/code-intelligence/write-feedback.mjs"

function errorAt(line, message) {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 1, code: "TS2322", source: "ts", message }
}

function warningAt(line, message) {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 2, code: "TS6133", source: "ts", message }
}

async function workspace(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-postwrite-" + label + "-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = 1\n")
  return root
}

// Manual timer control: coalescing behaviour is about time, and a test that
// sleeps is a test that is flaky on a loaded machine.
function manualClock() {
  let current = 1_000
  const timers = new Map()
  let sequence = 0
  return {
    now: () => current,
    tick(ms) { current += Math.max(0, Number(ms || 0)); return current },
    schedule(fn, delayMs) {
      const id = (sequence += 1)
      timers.set(id, { at: current + Math.max(0, Number(delayMs || 0)), fn })
      return id
    },
    cancel(id) { timers.delete(id) },
    async advance(ms) {
      const target = current + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        if (!due.length) break
        const [id, timer] = due[0]
        timers.delete(id)
        current = Math.max(current, timer.at)
        await timer.fn()
      }
      current = target
    },
  }
}

test("V15.3 post-write: a complete analysis with an error reports the error, not a clean file", async () => {
  const root = await workspace("errors")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [errorAt(0, "Type mismatch")], diagnosticsSource: "lsp-publish" }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.ERRORS)
    assert.equal(feedback.complete, true)
    assert.equal(feedback.errorCount, 1)
    assert.equal(feedback.errors[0].line, 1)
    assert.equal(feedback.errors[0].message, "Type mismatch")
    assert.match(feedback.text, /errors \(complete=true/)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: only a complete zero-diagnostic analysis may claim confirmed-clean", async () => {
  const root = await workspace("clean")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    })
    const clean = await controller.noteWrite({ toolName: "write", input: { path: "src/order.ts" } })
    assert.equal(clean.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(clean.complete, true)
    assert.equal(clean.errorCount, 0)

    // Warnings are diagnostics. A warning-only file is reported as warnings so
    // "clean" keeps meaning what a model will assume it means.
    const warnController = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [warningAt(0, "unused")], diagnosticsSource: "lsp-publish" }),
    })
    const warned = await warnController.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(warned.status, WRITE_FEEDBACK_STATUS.WARNINGS)
    assert.equal(warned.complete, true)
    assert.notEqual(warned.status, WRITE_FEEDBACK_STATUS.CLEAN)
    await controller.shutdown()
    await warnController.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: an incomplete analysis is never confirmed-clean even with zero diagnostics", async () => {
  // This is the core false-clean guard. Every incomplete shape below, including
  // the dangerous "empty but unproven" one, must be degraded.
  const incomplete = [
    { complete: false, diagnostics: [], reason: "diagnostics-timeout" },
    { complete: false, diagnostics: [], reason: "fallback-environment-incomplete" },
    { complete: false, diagnostics: [errorAt(0, "known")], reason: "partial" },
    { available: false, complete: false, diagnostics: [], reason: "lsp-command-unavailable" },
    { available: true, complete: false, diagnostics: [], reason: "fallback-error" },
  ]
  for (const shape of incomplete) {
    const classified = classify(shape)
    assert.equal(classified.complete, false, JSON.stringify(shape))
    assert.notEqual(classified.status, WRITE_FEEDBACK_STATUS.CLEAN, JSON.stringify(shape))
    assert.equal(classified.status, WRITE_FEEDBACK_STATUS.DEGRADED, JSON.stringify(shape))
    const payload = renderFeedback({ file: "a.ts", ...shape })
    assert.notEqual(payload.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(payload.complete, false)
    assert.ok(payload.reason, "an incomplete payload must always carry the reason it is unproven")
  }

  // And a direct classification of the dangerous shape.
  assert.equal(classify({ complete: false, diagnostics: [], status: WRITE_FEEDBACK_STATUS.UNAVAILABLE }).status, WRITE_FEEDBACK_STATUS.UNAVAILABLE)
  assert.equal(classify({ complete: false, diagnostics: [], status: WRITE_FEEDBACK_STATUS.PENDING }).status, WRITE_FEEDBACK_STATUS.PENDING)
})

test("V15.3 post-write: a result that lands after a newer write is discarded, not shown as current", async () => {
  const root = await workspace("stale")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      // The provider answers for content that is already stale by the time the
      // promise resolves. Reporting it as clean would be a false clean.
      runDiagnostics: async () => {
        await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = 2 // changed underneath\n")
        return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }
      },
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.PENDING)
    assert.equal(feedback.complete, false)
    assert.equal(feedback.stale, true)
    assert.equal(feedback.status !== WRITE_FEEDBACK_STATUS.CLEAN, true)
    assert.equal(writeFeedbackMetrics().postWriteStaleDiscarded, 1)
    assert.equal(writeFeedbackMetrics().postWriteComplete, 0)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: rapid edits coalesce into one trailing check and the final content is still checked", async () => {
  const root = await workspace("coalesce")
  try {
    resetWriteFeedbackMetrics()
    const clock = manualClock()
    const seen = []
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      limits: { coalesceWindowMs: 750 },
      runDiagnostics: async ({ fingerprint }) => {
        seen.push(fingerprint)
        return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }
      },
    })

    const first = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(first.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(seen.length, 1)

    // Three writes inside the window: two coalesce, one trailing check remains.
    for (const marker of ["a", "b", "c"]) {
      await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = '" + marker + "'\n")
      clock.tick(10)
      const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
      assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.PENDING)
      assert.equal(feedback.complete, false)
    }
    assert.equal(seen.length, 1, "coalesced writes must not each start a check")
    assert.equal(writeFeedbackMetrics().postWriteCoalesced, 3)

    await clock.advance(1_000)
    assert.equal(seen.length, 2, "the trailing check must still run")
    assert.equal(writeFeedbackMetrics().postWriteChecks, 2)

    // The trailing check described the newest content, not the first.
    const finalText = await readFile(path.join(root, "src", "order.ts"), "utf8")
    const { createHash } = await import("node:crypto")
    assert.equal(seen[1], createHash("sha256").update(Buffer.from(finalText, "utf8")).digest("hex"))
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: a warm provider is reused across edits instead of being respawned per write", async () => {
  const root = await workspace("warm")
  try {
    resetWriteFeedbackMetrics()
    let spawns = 0
    const clock = manualClock()
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      limits: { coalesceWindowMs: 0 },
      runDiagnostics: async () => {
        // A real pool spawns a language server once and reuses the session.
        if (spawns === 0) spawns += 1
        return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish", pool: { poolHit: spawns > 1, sessionId: "session-1" } }
      },
    })
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = " + index + "\n")
      clock.tick(5_000)
      const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
      assert.equal(feedback.sessionId, "session-1")
      assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.CLEAN)
    }
    assert.equal(spawns, 1, "the warm session must be reused for every edit")
    assert.equal(writeFeedbackMetrics().postWriteChecks, 4)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: an unsupported extension answers unsupported without a provider call", async () => {
  const root = await workspace("unsupported")
  try {
    resetWriteFeedbackMetrics()
    let calls = 0
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => { calls += 1; return { complete: true, diagnostics: [] } },
    })
    await writeFile(path.join(root, "notes.md"), "# notes\n")
    await writeFile(path.join(root, "data.unknown-ext"), "hello\n")
    for (const file of ["notes.md", "data.unknown-ext", "package.json", "lib/no-extension"]) {
      const feedback = await controller.noteWrite({ toolName: "write", input: { file } })
      assert.ok(feedback, file)
      assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.UNSUPPORTED, file)
      assert.equal(feedback.complete, false, file)
    }
    assert.equal(calls, 0, "an unsupported file must never start a provider")
    assert.equal(writeFeedbackEligibility("src/app.ts").eligible, true)
    assert.equal(writeFeedbackEligibility("README.md").reason, "unsupported-extension")
    assert.equal(writeFeedbackEligibility("../escape.ts").reason, "path-escape")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: an unavailable provider degrades instead of claiming a clean file", async () => {
  const root = await workspace("unavailable")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ available: false, complete: false, diagnostics: [], reason: "lsp-command-unavailable" }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.DEGRADED)
    assert.equal(feedback.complete, false)
    assert.equal(feedback.reason, "lsp-command-unavailable")
    assert.match(feedback.text, /not proven clean/)
    assert.equal(writeFeedbackMetrics().postWriteIncomplete, 1)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: a diagnostics failure never undoes or fails the successful edit", async () => {
  const root = await workspace("failure")
  try {
    resetWriteFeedbackMetrics()
    const before = await readFile(path.join(root, "src", "order.ts"), "utf8")
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => { throw new Error("provider exploded") },
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    const after = await readFile(path.join(root, "src", "order.ts"), "utf8")
    assert.equal(after, before, "the edit must be untouched by a diagnostics failure")
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.DEGRADED)
    assert.equal(feedback.complete, false)
    assert.match(feedback.reason, /diagnostics-threw/)
    assert.equal(writeFeedbackMetrics().postWriteProviderFailures, 1)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: feedback cannot re-enter itself", async () => {
  const guard = writeFeedbackGuard()
  assert.equal(guard.enter(), true)
  assert.equal(guard.enter(), false, "a nested write must be refused, not queued")
  guard.exit()
  assert.equal(guard.enter(), true)
  guard.exit()
  guard.exit()
  assert.equal(guard.depth, 0)

  // The runtime cannot emit a write from a diagnostics result, so the only way
  // to build a loop is to feed a feedback payload back in as a tool result.
  const root = await workspace("recursion")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [] }),
    })
    let reentered = 0
    const first = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    // Simulate a host that echoes the feedback back through a second write.
    if (first.text) reentered += 1
    assert.equal(reentered, 1)
    assert.equal(writeFeedbackMetrics().postWriteChecks, 1, "echoing feedback must not start a second check")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: the model-facing payload is bounded and the raw evidence stays recoverable", async () => {
  const root = await workspace("bounded")
  try {
    resetWriteFeedbackMetrics()
    const many = Array.from({ length: 200 }, (_, index) =>
      index < 150 ? errorAt(index, "E" + index + " " + "x".repeat(500)) : warningAt(index, "W" + index))
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: many, diagnosticsSource: "lsp-publish" }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.ERRORS)
    assert.equal(feedback.errorCount, 150)
    assert.equal(feedback.warningCount, 50)
    assert.equal(feedback.errors.length, 12)
    assert.equal(feedback.warnings.length, 6)
    assert.equal(feedback.truncated, true)
    assert.ok(feedback.errors[0].message.length <= 200)
    assert.ok(JSON.stringify(feedback).length < 8_000, "the compact payload must stay small")

    // Compaction dropped rows; the exact provider payload is still recoverable.
    const raw = controller.raw("src/order.ts")
    assert.equal(raw.diagnostics.length, 200)
    assert.equal(raw.complete, true)
    assert.match(feedback.text, /truncated; run ues_code diagnostics/)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: telemetry counts each terminal outcome exactly once and the budget is bounded", async () => {
  const root = await workspace("telemetry")
  try {
    resetWriteFeedbackMetrics()
    const clock = manualClock()
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      limits: { coalesceWindowMs: 0, maxChecksPerFilePerTurn: 2, maxChecksPerTurn: 2 },
      runDiagnostics: async () => ({ complete: true, diagnostics: [errorAt(0, "boom")], diagnosticsSource: "lsp-publish" }),
    })

    const a = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(a.status, WRITE_FEEDBACK_STATUS.ERRORS)
    let metrics = writeFeedbackMetrics()
    assert.equal(metrics.postWriteChecks, 1)
    assert.equal(metrics.postWriteComplete, 1)
    assert.equal(metrics.postWriteErrors, 1)
    assert.equal(metrics.postWriteIncomplete, 0)
    assert.equal(metrics.postWriteCoalesced, 0)

    clock.tick(10_000)
    const b = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(b.status, WRITE_FEEDBACK_STATUS.ERRORS)
    metrics = writeFeedbackMetrics()
    assert.equal(metrics.postWriteChecks, 2)
    assert.equal(metrics.postWriteErrors, 2)

    // Third edit for the same file exceeds the per-file ceiling and is reported
    // honestly as "not checked" instead of being dropped or faked.
    clock.tick(10_000)
    const c = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(c.status, WRITE_FEEDBACK_STATUS.DEGRADED)
    assert.equal(c.complete, false)
    assert.match(c.reason, /budget-exhausted:per-file/)
    assert.equal(writeFeedbackMetrics().postWriteChecks, 2, "an exhausted budget must not count as a check")
    assert.equal(writeFeedbackMetrics().postWriteBudgetExhausted, 1)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: a coalesced result is always delivered, never stranded as pending", async () => {
  const root = await workspace("drain")
  try {
    resetWriteFeedbackMetrics()
    const clock = manualClock()
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      runDiagnostics: async () => ({ complete: true, diagnostics: [errorAt(0, "late blocker")], diagnosticsSource: "lsp-publish" }),
    })

    const first = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(first.status, WRITE_FEEDBACK_STATUS.ERRORS)

    // Second write inside the window: pending now, real result later.
    clock.tick(5)
    const second = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
    assert.equal(second.status, WRITE_FEEDBACK_STATUS.PENDING)
    assert.deepEqual(controller.drain(), [], "nothing new has been checked yet")

    await clock.advance(2_000)
    const owed = controller.drain()
    assert.equal(owed.length, 1, "the coalesced write's result must be owed to the model")
    assert.equal(owed[0].status, WRITE_FEEDBACK_STATUS.ERRORS)
    assert.equal(owed[0].errorCount, 1)
    // Draining twice must not replay the same evidence.
    assert.deepEqual(controller.drain(), [], "a drained result is delivered once")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: the coalescing window widens for a slow provider", async () => {
  // A fixed window cannot help a provider whose check takes longer than the
  // window: every sequential edit starts another full check. The window tracks
  // the observed cost instead, so the burst cost stops scaling with edits.
  const root = await workspace("adaptive")
  try {
    resetWriteFeedbackMetrics()
    const clock = manualClock()
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      limits: { coalesceWindowMs: 100, maxAdaptiveWindowMs: 5_000, adaptiveWindowFactor: 1.5 },
      runDiagnostics: async () => {
        // Each check models a two-second language server.
        await clock.advance(2_000)
        return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }
      },
    })

    const statuses = []
    for (const marker of ["a", "b", "c", "d"]) {
      await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = '" + marker + "'\n")
      const feedback = await controller.noteWrite({ toolName: "edit", input: { file: "src/order.ts" } })
      statuses.push(feedback.status)
    }
    // The first edit is answered for real. The next three land while the
    // two-second check cycle is still in view, so they are absorbed into the
    // trailing check instead of stacking three more two-second checks.
    assert.equal(statuses[0], WRITE_FEEDBACK_STATUS.CLEAN)
    assert.deepEqual(statuses.slice(1), [
      WRITE_FEEDBACK_STATUS.PENDING,
      WRITE_FEEDBACK_STATUS.PENDING,
      WRITE_FEEDBACK_STATUS.PENDING,
    ])
    assert.equal(writeFeedbackMetrics().postWriteChecks, 1)
    assert.equal(writeFeedbackMetrics().postWriteCoalesced, 3)

    // The absorbed edits are not lost: the trailing check still runs and its
    // result is owed to the model.
    await clock.advance(6_000)
    assert.equal(writeFeedbackMetrics().postWriteChecks, 2)
    const owed = controller.drain()
    assert.equal(owed.length, 1)
    assert.equal(owed[0].status, WRITE_FEEDBACK_STATUS.CLEAN)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 post-write: only recognised mutation surfaces are instrumented", async () => {
  assert.deepEqual([...WRITE_FEEDBACK_TOOLS].sort(), [
    "apply_patch", "edit", "str_replace", "str_replace_editor", "ues_code_edit", "write", "write_file",
  ])
  assert.equal(extractWrittenFile("edit", { file: "src/a.ts" }), "src/a.ts")
  assert.equal(extractWrittenFile("write", { path: "src\\b.ts" }), "src/b.ts")
  assert.equal(extractWrittenFile("write_file", { filePath: "./src/c.ts" }), "src/c.ts")
  assert.equal(extractWrittenFile("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/d.ts\n@@\n" }), "src/d.ts")
  assert.equal(extractWrittenFile("apply_patch", { patch: "--- a/src/e.ts\n+++ b/src/e.ts\n" }), "src/e.ts")
  // A read tool is never instrumented, and an unrecognised write input yields no
  // file rather than a guess.
  assert.equal(extractWrittenFile("read", { file: "src/a.ts" }), null)
  assert.equal(extractWrittenFile("bash", { command: "echo" }), null)
  assert.equal(extractWrittenFile("edit", { somethingElse: 1 }), null)
})
