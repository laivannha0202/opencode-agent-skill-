// 15.3 independent hardening, sections C and D.
//
// C - reversible post-write evidence.
//   The candidate report claimed "raw diagnostics can be recovered with
//   controller.raw(file)". That is reachable only from inside this process: a
//   model cannot call it and a verifier cannot call it. Compaction is exactly
//   when a verifier needs the omitted rows, so the claim was true and useless.
//   These tests require an EXTERNALLY retrievable reference instead.
//
// D - multi-file mutation and budget exhaustion.
//   Pi 0.87.1 guarantees one file per `edit`/`write` call, proven from the tool
//   contract. Every other write tool name UES accepts comes from another host or
//   from an MCP server and may touch many files. A single-file verdict presented
//   for a three-file patch is a false clean about two thirds of the blast radius,
//   which is why coverage is now reported explicitly.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getEvidence, getEvidenceSelected } from "../lib/evidence-store.mjs"
import {
  MULTI_FILE_WRITE_TOOLS,
  SINGLE_FILE_WRITE_TOOLS,
  WRITE_FEEDBACK_TOOLS,
  createWriteFeedbackController,
  extractWrittenFile,
  extractWrittenFiles,
  resetWriteFeedbackMetrics,
  writeFeedbackMetrics,
  WRITE_FEEDBACK_STATUS,
} from "../lib/code-intelligence/write-feedback.mjs"

function errorAt(line, message) {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 1, code: "TS2322", source: "ts", message }
}

function warningAt(line, message) {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 2, code: "TS6133", source: "ts", message }
}

async function workspace(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-hardening-" + label + "-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  for (const name of ["a.ts", "b.ts", "c.ts", "notes.md"]) {
    await writeFile(path.join(root, "src", name), "export const x = 1\n")
  }
  return root
}

// ---------------------------------------------------------------------------
// C. Reversible post-write evidence
// ---------------------------------------------------------------------------

test("C >50 diagnostics keep the model-facing payload bounded and flag truncation", async () => {
  const root = await workspace("c-bounded")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({
        complete: true,
        // 40 errors and 30 warnings: well past the 12/6 visible limits.
        diagnostics: [
          ...Array.from({ length: 40 }, (_, index) => errorAt(index, "error-" + index)),
          ...Array.from({ length: 30 }, (_, index) => warningAt(index, "warning-" + index)),
        ],
        diagnosticsSource: "lsp-publish",
      }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.equal(feedback.errorCount, 40)
    assert.equal(feedback.warningCount, 30)
    assert.equal(feedback.errors.length, 12, "visible errors must stay bounded")
    assert.equal(feedback.warnings.length, 6, "visible warnings must stay bounded")
    assert.equal(feedback.truncated, true)
    assert.ok(JSON.stringify(feedback).length < 8_000, "compact payload must stay small")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("C an Evidence Store reference is exposed and resolves the omitted diagnostics", async () => {
  const root = await workspace("c-ref")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({
        complete: true,
        diagnostics: Array.from({ length: 120 }, (_, index) => errorAt(index, "diagnostic-" + index)),
        diagnosticsSource: "lsp-publish",
      }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })

    // 4. a reference exists and is visible to the model, not just to this process
    assert.ok(feedback.rawEvidence, "a truncated payload must expose a raw evidence reference")
    assert.ok(feedback.rawEvidence.ref, "the reference must be a non-empty string")
    assert.ok(feedback.rawEvidence.chars > 0)
    assert.equal(feedback.rawEvidence.omitted, 120 - 12)
    assert.match(feedback.text, /preserved:/, "the model-facing text must name the reference")
    assert.match(feedback.text, /context-expand/, "the model-facing text must name the retrieval path")

    // 5. the reference resolves through the same primitive UES already exposes.
    //    Retrieval is byte-paged by design, so a caller asks for enough bytes;
    //    `ues_evidence_get` caps a single call at 64,000 and pages beyond that.
    const page = await getEvidence(root, feedback.rawEvidence.ref, { maxBytes: 512_000 })
    assert.ok(page, "the reference must resolve")
    assert.equal(page.truncated === undefined || page.truncated === false, true, "the whole payload must be retrievable in one page")
    const payload = JSON.parse(String(page.content ?? page))

    // 6. the recovered payload contains the diagnostics the model never saw
    assert.equal(payload.diagnostics.length, 120)
    const visible = new Set(feedback.errors.map((row) => row.message))
    const omitted = payload.diagnostics.filter((row) => !visible.has(String(row.message)))
    assert.equal(omitted.length, 108, "every omitted row must be recoverable")
    assert.ok(omitted.some((row) => row.message === "diagnostic-119"), "the last omitted row must be present")
    assert.equal(payload.file, "src/a.ts")
    assert.equal(payload.complete, true)

    // The same store also answers a selector query, which is what a verifier
    // would use to pull one specific field without the whole blob.
    const selected = await getEvidenceSelected(root, feedback.rawEvidence.ref, { maxBytes: 512_000 })
    assert.ok(selected, "a selector query must resolve too")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("C an untruncated result writes no evidence at all", async () => {
  const root = await workspace("c-noevidence")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [errorAt(0, "only one")], diagnosticsSource: "lsp-publish" }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.equal(feedback.truncated, false)
    assert.equal(feedback.rawEvidence, undefined, "nothing was omitted, so nothing should be stored")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("C a stale result writes no evidence and cannot replace the current reference", async () => {
  const root = await workspace("c-stale")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({
        complete: true,
        diagnostics: Array.from({ length: 90 }, (_, index) => errorAt(index, "stale-" + index)),
        diagnosticsSource: "lsp-publish",
      }),
    })
    // First check: good, produces a reference.
    const good = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.ok(good.rawEvidence?.ref, "the first check must produce a reference")
    const goodRef = good.rawEvidence.ref
    const goodRaw = controller.raw("src/a.ts")
    assert.equal(goodRaw.rawEvidence.ref, goodRef)

    // Second check: the file changes underneath the provider, so the result is
    // discarded. It must not publish evidence describing content that is gone.
    const staleController = createWriteFeedbackController({
      root,
      runDiagnostics: async () => {
        await writeFile(path.join(root, "src", "a.ts"), "export const x = 2 // changed\n")
        return {
          complete: true,
          diagnostics: Array.from({ length: 90 }, (_, index) => errorAt(index, "stale-" + index)),
          diagnosticsSource: "lsp-publish",
        }
      },
    })
    const stale = await staleController.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.equal(stale.status, WRITE_FEEDBACK_STATUS.PENDING)
    assert.equal(stale.stale, true)
    assert.equal(stale.rawEvidence, undefined, "a discarded result must not publish evidence")
    assert.equal(staleController.raw("src/a.ts"), null, "a discarded result must not become the slot's raw evidence")

    // The surviving controller still resolves to the reference for real content.
    const recovered = await getEvidence(root, goodRef)
    assert.ok(recovered, "the current reference must remain retrievable")
    await controller.shutdown()
    await staleController.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("C evidence storage failure degrades the feedback instead of the edit", async () => {
  const root = await workspace("c-storefail")
  try {
    resetWriteFeedbackMetrics()
    // Force putEvidence to fail by making the evidence directory a file.
    await writeFile(path.join(root, ".ues-cache"), "not a directory\n")
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({
        complete: true,
        diagnostics: Array.from({ length: 80 }, (_, index) => errorAt(index, "boom-" + index)),
        diagnosticsSource: "lsp-publish",
      }),
    })
    const feedback = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    // The check still reports; only the recovery reference is absent, and that is
    // stated rather than hidden.
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.ERRORS)
    assert.equal(feedback.errorCount, 80)
    assert.equal(feedback.rawEvidence, undefined)
    assert.equal((await readFile(path.join(root, "src", "a.ts"), "utf8")).includes("export const x = 1"), true, "the edit is intact")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// D. Multi-file mutation
// ---------------------------------------------------------------------------

test("D the Pi single-file contract is encoded, and only for the tools Pi ships", () => {
  // Pi 0.87.1: edit = { path, edits[] }, write = { path, content }. Both are
  // one file per call. There is no apply_patch, write_file or str_replace in Pi,
  // so those names cannot inherit the guarantee.
  assert.deepEqual([...SINGLE_FILE_WRITE_TOOLS].sort(), ["edit", "write"])
  for (const name of MULTI_FILE_WRITE_TOOLS) {
    assert.equal(SINGLE_FILE_WRITE_TOOLS.includes(name), false, name)
  }
  assert.deepEqual([...WRITE_FEEDBACK_TOOLS].sort(), [
    "apply_patch", "edit", "str_replace", "str_replace_editor", "ues_code_edit", "write", "write_file",
  ])
})

test("D a three-file patch discovers all three files", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "*** Update File: src/b.ts",
    "@@",
    "*** Update File: src/c.ts",
    "*** End Patch",
  ].join("\n")
  assert.deepEqual(extractWrittenFiles("apply_patch", { patch }), ["src/a.ts", "src/b.ts", "src/c.ts"])
  // A unified-diff envelope names the same file twice; it must be deduplicated.
  const unified = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+export const y = 2\n"
  assert.deepEqual(extractWrittenFiles("apply_patch", { patch: unified }), ["src/a.ts"])
  // An explicit path wins, and patch headers are unioned with it.
  assert.deepEqual(extractWrittenFiles("apply_patch", { file: "src/notes.md", patch }), ["src/notes.md", "src/a.ts", "src/b.ts", "src/c.ts"])
  // A multi-file host tool that takes an array.
  assert.deepEqual(extractWrittenFiles("write_file", { files: ["src/a.ts", "src/b.ts"] }), ["src/a.ts", "src/b.ts"])
  // A read tool is still never instrumented.
  assert.deepEqual(extractWrittenFiles("read", { file: "src/a.ts" }), [])
  // The single-file accessor is the first element, which is what the child
  // runtime's own anchored editor uses.
  assert.equal(extractWrittenFile("edit", { path: "src/a.ts" }), "src/a.ts")
})

test("D a three-file patch checks each file and reports coverage honestly", async () => {
  const root = await workspace("d-three")
  try {
    resetWriteFeedbackMetrics()
    const seen = []
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async ({ relative }) => {
        seen.push(relative)
        return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }
      },
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** Update File: src/notes.md",
      "*** End Patch",
    ].join("\n")
    const feedback = await controller.noteWrite({ toolName: "apply_patch", input: { patch } })

    assert.equal(feedback.filesDiscovered, 3)
    assert.equal(feedback.singleFileContract, false)
    // Every ELIGIBLE file reached the controller, each exactly once.
    assert.deepEqual(seen.sort(), ["src/a.ts", "src/b.ts"])
    assert.equal(feedback.filesChecked, 2)
    // The unsupported file is named, not silently dropped.
    assert.deepEqual(feedback.filesUnsupported, ["src/notes.md"])
    // Because an unsupported file is in the blast radius, the call is NOT clean.
    assert.notEqual(feedback.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(feedback.complete, false)
    assert.match(feedback.text, /3 file\(s\) discovered|2\/3 file\(s\) checked/)
    assert.match(feedback.text, /not instrumented \(unsupported\): src\/notes\.md/)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D a three-file patch whose files all pass is still not confirmed-clean while any is unproven", async () => {
  const root = await workspace("d-clean-coverage")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => ({ complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** Update File: src/c.ts",
      "*** End Patch",
    ].join("\n")
    const feedback = await controller.noteWrite({ toolName: "apply_patch", input: { patch } })
    assert.equal(feedback.filesDiscovered, 3)
    assert.equal(feedback.filesChecked, 3)
    assert.equal(feedback.filesUnsupported.length, 0)
    assert.equal(feedback.filesNotProven.length, 0)
    // Full coverage on a multi-file call IS allowed to be a clean verdict --
    // the point is that it is earned, not assumed.
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(feedback.complete, true)
    assert.equal(feedback.singleFileContract, false)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D an error in any file of a multi-file call surfaces as an error verdict", async () => {
  const root = await workspace("d-error")
  try {
    resetWriteFeedbackMetrics()
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async ({ relative }) => (relative === "src/b.ts"
        ? { complete: true, diagnostics: [errorAt(0, "broken")], diagnosticsSource: "lsp-publish" }
        : { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** Update File: src/c.ts",
      "*** End Patch",
    ].join("\n")
    const feedback = await controller.noteWrite({ toolName: "apply_patch", input: { patch } })
    assert.equal(feedback.status, WRITE_FEEDBACK_STATUS.ERRORS)
    assert.equal(feedback.complete, false)
    assert.deepEqual(feedback.errorFiles, ["src/b.ts"])
    assert.match(feedback.text, /errors/)
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D no duplicate check runs for the same content generation", async () => {
  const root = await workspace("d-nodup")
  try {
    resetWriteFeedbackMetrics()
    let calls = 0
    const controller = createWriteFeedbackController({
      root,
      runDiagnostics: async () => { calls += 1; return { complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" } },
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** End Patch",
    ].join("\n")
    const feedback = await controller.noteWrite({ toolName: "apply_patch", input: { patch } })
    assert.equal(feedback.filesDiscovered, 2, "a repeated path in one payload is one file")
    assert.equal(calls, 2, "one check per distinct file, no duplicates")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D budget exhaustion leaves the latest write explicitly unverified and never clean", async () => {
  const root = await workspace("d-budget")
  try {
    resetWriteFeedbackMetrics()
    let clock = 1_000
    const timers = new Map()
    let sequence = 0
    const controller = createWriteFeedbackController({
      root,
      now: () => clock,
      schedule: (fn, delayMs) => { const id = (sequence += 1); timers.set(id, fn); return id },
      cancelSchedule: (id) => { timers.delete(id) },
      limits: { maxChecksPerFilePerTurn: 1, maxChecksPerTurn: 1, coalesceWindowMs: 0 },
      runDiagnostics: async () => ({ complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    })

    const first = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.equal(first.status, WRITE_FEEDBACK_STATUS.CLEAN)

    // A new content generation arrives after the budget is spent.
    await writeFile(path.join(root, "src", "a.ts"), "export const x = 2\n")
    clock += 60_000
    const second = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } })
    assert.equal(second.status, WRITE_FEEDBACK_STATUS.DEGRADED)
    assert.equal(second.complete, false, "an unverified write must never be reported as clean")
    assert.match(second.reason, /budget-exhausted/)
    assert.notEqual(second.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(second.generation, undefined, "no stale generation is claimed")

    // Telemetry moved exactly once for the refusal and never for the skipped check.
    assert.equal(writeFeedbackMetrics().postWriteBudgetExhausted, 1)
    assert.equal(writeFeedbackMetrics().postWriteChecks, 1, "a refused check must not count as a check")

    // The edit itself is untouched.
    assert.equal(await readFile(path.join(root, "src", "a.ts"), "utf8"), "export const x = 2\n")
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D budget exhaustion inside a multi-file call never launders the whole patch as clean", async () => {
  const root = await workspace("d-budget-multi")
  try {
    resetWriteFeedbackMessages()
    const controller = createWriteFeedbackController({
      root,
      limits: { maxChecksPerFilePerTurn: 0, maxChecksPerTurn: 0, coalesceWindowMs: 0 },
      runDiagnostics: async () => ({ complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** Update File: src/c.ts",
      "*** End Patch",
    ].join("\n")
    const feedback = await controller.noteWrite({ toolName: "apply_patch", input: { patch } })
    assert.equal(feedback.filesDiscovered, 3)
    assert.equal(feedback.filesChecked, 0, "a refused file is not a checked file")
    assert.equal(feedback.complete, false)
    assert.notEqual(feedback.status, WRITE_FEEDBACK_STATUS.CLEAN)
    assert.equal(feedback.filesNotProven.length, 3, "every unverified file must be named")
    assert.match(feedback.reason, /3-of-3-files-unverified/)
    // The verdict names each file it could not prove, so a model can go check.
    for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      assert.ok(feedback.filesNotProven.includes(file), `${file} must be listed as unverified`)
      assert.match(feedback.text, new RegExp(file.replace(/[./]/g, "\$&")), `${file} must appear in the model-facing text`)
    }
    await controller.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function resetWriteFeedbackMessages() {
  resetWriteFeedbackMetrics()
}
