import assert from "node:assert/strict"
import test from "node:test"

import {
  createWebReasoningLane,
  packetBudgetForTier,
  packetInputFrom,
} from "../lib/web-reasoning-lane.mjs"
import { DECISION_PACKET_SECTION } from "../lib/decision-packet.mjs"
import { PACKET_TIER, PACKET_TIER_BUDGET } from "../lib/decision-packet-tiers.mjs"

const GOOD_ADVICE = {
  summary: "Use the locally grounded browser lane as the concrete edit target.",
  hypotheses: ["The production wiring should enforce the selected packet tier."],
  recommendedApproach: ["Keep the change bounded and verify it locally."],
  filesToInspect: ["lib/browser-lane.mjs"],
  risks: ["A stale or oversized packet wastes context."],
  edgeCases: ["Browser readiness can be slower than local packet preparation."],
  verificationSuggestions: ["Run the production wiring regression."],
  confidence: 0.9,
}

function readyProvider(overrides = {}) {
  const calls = { capability: 0, consult: 0, packets: [] }
  return {
    calls,
    adapter: {
      id: "deepseek-web",
      capability: async (context) => {
        calls.capability += 1
        if (overrides.capability) return overrides.capability(context)
        return { state: "ready", reason: "ready", supportsFollowUp: true }
      },
      startSession: async () => ({ sessionId: "economy-prod", state: "ready" }),
      consult: async (_session, packet) => {
        calls.consult += 1
        calls.packets.push(packet)
        return { answer: JSON.stringify(GOOD_ADVICE), latencyMs: 1 }
      },
      followUp: async () => ({ answer: JSON.stringify(GOOD_ADVICE), latencyMs: 1 }),
      closeSession: async () => true,
    },
  }
}

function packetRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    path: `lib/economy-fixture-${index}.mjs`,
    role: "source",
    reason: "production packet budget fixture",
  }))
}

function snippetRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    path: `lib/economy-fixture-${index}.mjs`,
    symbol: `fixture${index}`,
    text: `export const fixture${index} = ${JSON.stringify("x".repeat(900))}`,
  }))
}

function evidenceRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: "runtime",
    source: `fixture-${index}`,
    text: `evidence-${index}-${"y".repeat(700)}`,
  }))
}

function consultInput(overrides = {}) {
  return {
    task: "Review this implementation with a second opinion before the concrete edit.",
    knownFiles: ["lib/browser-lane.mjs"],
    relevantFiles: packetRows(20),
    snippets: snippetRows(10),
    evidence: evidenceRows(3),
    constraints: ["MUST keep local verification authoritative"],
    verification: ["node --test test/web-reasoning-production-economy-v16-7-1.test.mjs"],
    ...overrides,
  }
}

test("V16.7.1 production packet budget: SMALL/MEDIUM/LARGE resolve to their real builder limits", () => {
  assert.deepEqual(packetBudgetForTier(PACKET_TIER.SMALL, 48_000), PACKET_TIER_BUDGET.small)
  assert.deepEqual(packetBudgetForTier(PACKET_TIER.MEDIUM, 48_000), PACKET_TIER_BUDGET.medium)
  assert.deepEqual(packetBudgetForTier(PACKET_TIER.LARGE, 48_000), PACKET_TIER_BUDGET.large)
  assert.equal(packetBudgetForTier(PACKET_TIER.SMALL, 7_000).maxPacketChars, 7_000)
})

test("V16.7.1 production packet budget: a SMALL consult cannot inherit the 48k/24-file defaults", async () => {
  const { calls, adapter } = readyProvider()
  const lane = createWebReasoningLane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [adapter],
    maxPacketChars: 48_000,
  })

  const result = await lane.consult(consultInput({ affectedSubsystems: 1 }))
  assert.equal(result.outcome, "advised")
  assert.equal(result.packet.tier, "small")
  assert.deepEqual(result.packet.budget, PACKET_TIER_BUDGET.small)
  assert.ok(result.packet.files <= PACKET_TIER_BUDGET.small.maxFiles)
  assert.ok(result.packet.evidenceCount <= PACKET_TIER_BUDGET.small.maxEvidence)
  assert.ok(result.packet.chars <= PACKET_TIER_BUDGET.small.maxPacketChars)
  assert.equal(calls.consult, 1)

  const packet = calls.packets[0]
  assert.ok(packet.sections[DECISION_PACKET_SECTION.RELEVANT_FILES].length <= PACKET_TIER_BUDGET.small.maxFiles)
  assert.ok(packet.sections[DECISION_PACKET_SECTION.SNIPPETS].length <= PACKET_TIER_BUDGET.small.maxSnippets)
  assert.ok(packet.sections[DECISION_PACKET_SECTION.FAILING_EVIDENCE].length <= PACKET_TIER_BUDGET.small.maxEvidence)
})

test("V16.7.1 production packet budget: MEDIUM is actually capped at the medium limits", async () => {
  const { adapter } = readyProvider()
  const lane = createWebReasoningLane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [adapter],
    maxPacketChars: 48_000,
  })
  const result = await lane.consult(consultInput({
    affectedSubsystems: 2,
    evidence: evidenceRows(6),
    diff: "z".repeat(4_000),
  }))
  assert.equal(result.outcome, "advised")
  assert.equal(result.packet.tier, "medium")
  assert.deepEqual(result.packet.budget, PACKET_TIER_BUDGET.medium)
  assert.ok(result.packet.files <= PACKET_TIER_BUDGET.medium.maxFiles)
  assert.ok(result.packet.chars <= PACKET_TIER_BUDGET.medium.maxPacketChars)
})

test("V16.7.1 production prep: capability and real packet building are in flight together", async () => {
  let capabilityStarted = false
  let packetStarted = false
  let release
  let markBoth
  const gate = new Promise((resolve) => { release = resolve })
  const bothStarted = new Promise((resolve) => { markBoth = resolve })
  const mark = () => {
    if (capabilityStarted && packetStarted) markBoth()
  }

  const { adapter } = readyProvider({
    capability: async () => {
      capabilityStarted = true
      mark()
      await gate
      return { state: "ready", reason: "ready", supportsFollowUp: true }
    },
  })
  const lane = createWebReasoningLane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [adapter],
    prepTimeoutMs: 2_000,
    buildPacket: async (input, { signal } = {}) => {
      assert.equal(signal?.aborted, false)
      packetStarted = true
      mark()
      await gate
      return packetInputFrom(input)
    },
  })

  const consultation = lane.consult(consultInput({ affectedSubsystems: 1 }))
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("production lanes did not overlap")), 500)),
  ])
  assert.equal(capabilityStarted, true)
  assert.equal(packetStarted, true)
  release()
  const result = await consultation
  assert.equal(result.outcome, "advised")
  assert.equal(result.prepTelemetry.parallel, true)
})

test("V16.7.1 production prep: hard timeout aborts cooperative readiness and AUTO falls back locally", async () => {
  let sawAbort = false
  const { adapter } = readyProvider({
    capability: ({ signal } = {}) => new Promise((_resolve, reject) => {
      const fail = () => {
        sawAbort = true
        reject(new Error("capability aborted"))
      }
      if (signal?.aborted) fail()
      else signal?.addEventListener?.("abort", fail, { once: true })
    }),
  })
  const lane = createWebReasoningLane({
    mode: "auto",
    provider: "deepseek-web",
    adapters: [adapter],
    prepTimeoutMs: 25,
  })
  const result = await lane.consult(consultInput({
    task: "The verifier still fails across multiple modules and the root cause is ambiguous.",
    affectedSubsystems: 2,
  }))
  assert.equal(result.outcome, "fallback-local")
  assert.equal(result.fallbackToLocal, true)
  assert.equal(result.prepTelemetry.timedOut, true)
  assert.equal(result.prepTelemetry.aborted, true)
  assert.equal(sawAbort, true)
})
