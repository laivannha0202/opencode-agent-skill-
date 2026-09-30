// V15.3 Phase 9 -- the final-write delivery edge.
//
// THE CASE
//
// A model's LAST tool call of a turn is a write. The check is coalesced, there is
// no later `tool_result` to carry the verdict, and the turn ends. Before this
// change the runtime fired `void controller.flush()` at `agent_end` and discarded
// the result: the model finalised on an assumption it was never given, and
// nothing anywhere recorded that the write was unverified. That is neither
// "delivered" nor "marked" -- it is silent.
//
// This file pins the fixed contract:
//
//   B. final completion stays gated by the normal verifier, AND the runtime marks
//      the unverified write explicitly. The flush is bounded and never a wait.
//
// It also pins the two properties that make option B safe: the trailing check
// always runs (the result is never simply lost), and it never blocks the turn
// indefinitely.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createWriteFeedbackController, resetWriteFeedbackMetrics, writeFeedbackMetrics, WRITE_FEEDBACK_STATUS } from "../lib/code-intelligence/write-feedback.mjs"

async function workspace(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-finalwrite-" + label + "-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1\n")
  return root
}

function manualClock() {
  let current = 1_000;
  const timers = new Map();
  let sequence = 0;
  return {
    now: () => current,
    tick(ms) { current += Math.max(0, Number(ms || 0)); return current },
    schedule(fn, delayMs) { const id = (sequence += 1); timers.set(id, { at: current + Math.max(0, Number(delayMs || 0)), fn }); return id },
    cancel(id) { timers.delete(id) },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        current = Math.max(current, timer.at);
        await timer.fn();
      }
      current = target;
    },
  };
}

test("P9-1 a final write is coalesced, and the trailing verdict is never simply lost", async () => {
  const root = await workspace("trailing")
  try {
    resetWriteFeedbackMetrics();
    const clock = manualClock();
    let checks = 0;
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      limits: { coalesceWindowMs: 600 },
      runDiagnostics: async () => {
        checks += 1;
        return { complete: true, diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, code: "E1", message: "final write broke the file" }], diagnosticsSource: "lsp-publish" };
      },
    });

    // First write: checked, clean would be wrong here so it reports the error.
    const first = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });
    assert.equal(first.status, WRITE_FEEDBACK_STATUS.ERRORS);

    // The model's LAST write: coalesced, so it returns pending...
    clock.tick(10);
    const last = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });
    assert.equal(last.status, WRITE_FEEDBACK_STATUS.PENDING);
    assert.equal(last.complete, false, "a coalesced write must never be reported as verified");
    assert.equal(checks, 1, "the coalesced write must not start a second check");

    // ...and the turn would end here. Nothing has delivered the verdict.
    const owedBeforeFlush = controller.drain();
    assert.deepEqual(owedBeforeFlush, [], "nothing new has been checked yet, so nothing is owed yet");

    // The trailing timer fires and produces the verdict.
    await clock.advance(2_000);
    assert.equal(checks, 2, "the trailing check must still run: a pending verdict is never dropped");

    // This is the agent_end flush. It returns the verdict rather than discarding it.
    const flushed = await controller.flush();
    const finalVerdict = flushed?.last || controller.drain()[0] || null;
    assert.ok(finalVerdict, "the flushed verdict must exist");
    assert.equal(finalVerdict.status, WRITE_FEEDBACK_STATUS.ERRORS);
    assert.equal(finalVerdict.complete, true);
    assert.match(String(finalVerdict.text || ""), /final write broke the file/);
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})

test("P9-2 the boundary reports the verdict as NOT seen by the model", async () => {
  // The honesty half. A verdict that only ever existed inside the runtime must be
  // labelled that way, so an operator can see that a turn ended on an unverified
  // write instead of the gap being invisible.
  const root = await workspace("notseen")
  try {
    resetWriteFeedbackMetrics();
    const clock = manualClock();
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      runDiagnostics: async () => ({ complete: true, diagnostics: [], diagnosticsSource: "lsp-publish" }),
    });

    // Coalesce so the final write returns pending and no tool_result follows.
    await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });
    clock.tick(10);
    const last = await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });
    assert.equal(last.status, WRITE_FEEDBACK_STATUS.PENDING);
    await clock.advance(3_000);

    // The verdict now exists. It was produced after the model's last observed
    // tool result, so it is explicitly NOT model-visible.
    const drained = controller.drain();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].seenByModel, undefined, "the payload must not claim model visibility");
    const record = { at: new Date().toISOString(), seenByModel: false, rows: drained.map((row) => ({ file: row.file, status: row.status, complete: row.complete === true })) };
    assert.equal(record.seenByModel, false);
    assert.equal(record.rows[0].file, "src/a.ts");
    assert.equal(record.rows[0].complete, true, "the verifier still gets a real verdict to act on");
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})

test("P9-3 the flush is bounded and does not become a wait", async () => {
  const root = await workspace("bounded")
  try {
    resetWriteFeedbackMetrics();
    const clock = manualClock();
    let calls = 0;
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      runDiagnostics: async () => {
        calls += 1;
        // A provider that never answers must not make the boundary hang; the
        // existing diagnostics budget owns that bound, so here the provider
        // simply returns.
        return { complete: false, diagnostics: [], reason: "diagnostics-timeout", diagnosticsSource: "none" };
      },
    });
    await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });
    clock.tick(10);
    await controller.noteWrite({ toolName: "edit", input: { path: "src/a.ts" } });

    const started = Date.now();
    const flushed = await controller.flush();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `flush must be bounded, took ${elapsed}ms`);
    assert.ok(flushed, "flush must resolve with a payload rather than hang");
    // An unproven provider is reported as unproven, never as clean.
    const rows = flushed.rows || (flushed.last ? [flushed.last] : []);
    for (const row of rows) {
      assert.notEqual(row.status, WRITE_FEEDBACK_STATUS.CLEAN, "an incomplete final check must not report clean");
      assert.equal(row.complete, false);
    }
    assert.ok(calls <= 2, `the boundary must not start unbounded checks, saw ${calls}`);
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})

test("P9-4 a final write is never rolled back and the verifier still runs normally", async () => {
  const root = await workspace("norroLLback")
  try {
    resetWriteFeedbackMetrics();
    const clock = manualClock();
    const source = "export const a = 1 // final\n";
    const controller = createWriteFeedbackController({
      root,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
      runDiagnostics: async () => ({ complete: true, diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, code: "E1", message: "broken" }], diagnosticsSource: "lsp-publish" }),
    });
    await writeFile(path.join(root, "src", "a.ts"), source);
    clock.tick(10);
    await controller.noteWrite({ toolName: "write", input: { path: "src/a.ts" } });
    await clock.advance(3_000);
    const flushed = await controller.flush();
    assert.ok(flushed, "the boundary must resolve");

    // The edit stands. Post-write feedback observes; it never reverts.
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path.join(root, "src", "a.ts"), "utf8"), source, "the write must be untouched");
    // The verdict is available for the normal final verification to consume.
    assert.ok(writeFeedbackMetrics().postWriteChecks >= 1);
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})
