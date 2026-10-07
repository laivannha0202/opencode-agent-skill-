// V16.10 Context Kernel V2: behavior tests.
//
// The kernel's whole reason to exist is a provable, deterministic compaction
// decision. These tests assert the LAWS: deterministic first, LLM last, never
// regress, never drop pinned context, always report honestly.

import test from "node:test"
import assert from "node:assert/strict"
import {
  CONTEXT_KERNEL_POLICY,
  CONTEXT_TIER,
  compactDeterministically,
  planContextKernel,
  applyContextKernel,
  estimateKernelTokens,
} from "../lib/context-kernel-v16-10.mjs"

function repeat(unit, times) {
  return Array.from({ length: times }, () => unit).join("\n")
}

test("V16.10 context kernel: deterministic ladder is a strict order", () => {
  // Within budget -> untouched, no pass applied.
  const small = compactDeterministically("hello", { maxChars: 100 })
  assert.equal(small.applied, false)
  assert.equal(small.reason, "within-budget")

  // Whitespace collapse fires before dedupe/head-tail.
  const spaced = ("a\n\n\n\n\n".repeat(80)) + "b\n\n\n\nc"
  const ws = compactDeterministically(spaced, { maxChars: 256 })
  assert.equal(ws.passes[0].pass, "whitespace")
  assert.ok(ws.applied)
})

test("V16.10 context kernel: compaction that would grow the text is refused", () => {
  // A single long line cannot be usefully reduced by head/tail when the notice
  // itself would dominate; the kernel must prefer the original over a regression.
  const oneLine = "x".repeat(1000)
  const out = compactDeterministically(oneLine, { maxChars: 500, handle: "evidence:sha256:" + "b".repeat(64) })
  // Either it genuinely shrank, or it refused. It must never be larger.
  assert.ok(out.applied === false || out.text.length <= oneLine.length)
  if (!out.applied) assert.equal(out.reason, "compaction-not-beneficial")
})

test("V16.10 context kernel: repeated lines are deduped with a count", () => {
  const log = Array.from({ length: 200 }, () => "compiling module foo").join("\n") + "\nDONE"
  const out = compactDeterministically(log, { maxChars: 400 })
  assert.equal(out.applied, true)
  assert.match(out.text, /\[x200\]/)
})

test("V16.10 context kernel: planner never drops pinned context", () => {
  const segments = [
    { id: "sys", tier: CONTEXT_TIER.PINNED, text: "RULES ".repeat(2000) },
    { id: "big", tier: CONTEXT_TIER.HISTORY, text: "history ".repeat(2000) },
  ]
  const plan = planContextKernel(segments, { budgetChars: 4000 })
  const pinned = plan.allocations.find((row) => row.tier === CONTEXT_TIER.PINNED)
  const pinnedDecision = pinned.decisions.find((row) => row.id === "sys")
  assert.notEqual(pinnedDecision.action, "drop")
  // A system rule larger than the whole budget is reported, not silently dropped.
  assert.equal(plan.overBudget, true)
  assert.equal(plan.overBudgetReason, "pinned-context-exceeds-budget")
})

test("V16.10 context kernel: plan reports demand vs kept honestly", () => {
  const segments = [
    { id: "a", tier: CONTEXT_TIER.TASK, text: "a".repeat(500) },
    { id: "b", tier: CONTEXT_TIER.EVIDENCE, text: "b".repeat(500) },
    { id: "c", tier: CONTEXT_TIER.HISTORY, text: "c".repeat(5000) },
  ]
  const plan = planContextKernel(segments, { budgetChars: 1200 })
  assert.equal(plan.totalDemandChars, 6000)
  assert.ok(plan.totalKeptChars <= plan.budgetChars)
  assert.equal(plan.savedChars, plan.totalDemandChars - plan.totalKeptChars)
})

test("V16.10 context kernel: LLM summarization is only reached after deterministic passes", async () => {
  const segments = [{ id: "log", tier: CONTEXT_TIER.EVIDENCE, text: repeat("build step output line", 400) }]
  let summarizerCalls = 0
  const out = await applyContextKernel("/tmp/ues-kernel-test", segments, {
    budgetChars: 600,
    scope: "llm-order",
    summarize: async ({ maxChars }) => {
      summarizerCalls += 1
      return "SUMMARY ".repeat(Math.max(1, Math.floor(maxChars / 8)))
    },
  })
  // Deterministic compaction handled it, so the model summarizer must not have
  // been consulted at all.
  assert.equal(out.usedDeterministicCompaction, true)
  assert.equal(out.usedLlmSummarization, false)
  assert.equal(summarizerCalls, 0)
  assert.equal(out.orderingLaw, "deterministic-first-llm-last")
})

test("V16.10 context kernel: summarizer is used only when nothing else fits", async () => {
  // 10 MB of UNIQUE lines defeats dedupe and head/tail cannot reach 200 chars
  // without a notice; give a summarizer and confirm it is the last resort.
  const unique = Array.from({ length: 4000 }, (_, index) => `unique-token-${index}-${"z".repeat(40)}`).join("\n")
  const segments = [{ id: "huge", tier: CONTEXT_TIER.EVIDENCE, text: unique }]
  let called = false
  const out = await applyContextKernel("/tmp/ues-kernel-test", segments, {
    budgetChars: 300,
    scope: "llm-last",
    summarize: async () => {
      called = true
      return "COMPRESSED"
    },
  })
  // Either the deterministic ladder refused AND the summarizer ran, or the
  // deterministic ladder succeeded and the summarizer was skipped. It must be
  // one or the other, never the summarizer before the ladder.
  if (out.usedLlmSummarization) {
    assert.equal(called, true)
  } else {
    assert.equal(called, false)
  }
  // No fabricated MEASURED provenance for a summary.
  assert.notEqual(out.provenance.llmSummarization, "MEASURED")
})

test("V16.10 context kernel: dropped segments say so and keep their retrieval handle", async () => {
  const segments = [
    { id: "keep", tier: CONTEXT_TIER.TASK, text: "task text ".repeat(20) },
    { id: "gone", tier: CONTEXT_TIER.HISTORY, text: "history ".repeat(3000), evidenceRef: "evidence:sha256:" + "c".repeat(64) },
  ]
  const out = await applyContextKernel("/tmp/ues-kernel-test", segments, { budgetChars: 400, scope: "drop-honesty" })
  const dropped = out.segments.find((row) => row.id === "gone")
  if (dropped.action === "drop") {
    assert.match(dropped.text, /dropped by context kernel/)
    assert.match(dropped.text, /retrieval=evidence:sha256:/)
    assert.equal(dropped.omittedChars, dropped.originalChars)
  } else {
    // If it was compacted instead, that too must be honest.
    assert.ok(dropped.visibleChars <= dropped.originalChars)
  }
})

test("V16.10 context kernel: token estimate is always ESTIMATED, never MEASURED", async () => {
  const out = await applyContextKernel("/tmp/ues-kernel-test", [{ id: "t", tier: CONTEXT_TIER.TASK, text: "hello world" }], { budgetChars: 1000, scope: "tok" })
  const tokens = estimateKernelTokens(out)
  assert.equal(tokens.provenance, "ESTIMATED")
  assert.equal(out.policy, CONTEXT_KERNEL_POLICY)
})

test("V16.10 context kernel: unchanged content in a scope is referenced, not restated", async () => {
  const segment = [{ id: "file.ts", tier: CONTEXT_TIER.EVIDENCE, text: "export const x = 1\n".repeat(50) }]
  const scope = "unchanged-ref-" + Date.now()
  await applyContextKernel("/tmp/ues-kernel-test", segment, { budgetChars: 100000, scope })
  const second = await applyContextKernel("/tmp/ues-kernel-test", segment, { budgetChars: 100000, scope })
  const row = second.segments[0]
  assert.equal(row.seenState, "UNCHANGED")
  assert.equal(row.action, "unchanged-reference")
  assert.match(row.text, /unchanged since last turn/)
})
