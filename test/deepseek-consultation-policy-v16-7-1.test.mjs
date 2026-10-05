// V16.7.1 Parts 8-12 and 16-18: the bounded consultation policy, the parallel
// prep lane, the compact packet and capsule, the bounded follow-up budget, the
// benchmark's NOT_MEASURED honesty, and the documented AUTO/OFF/FORCE posture.
//
// These contracts already existed across V16.3-V16.7; this file is the single
// place that pins them for V16.7.1 so a future refactor cannot silently widen a
// budget, drop a skip-list entry, or start reporting an unmeasured number as if
// it were measured.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  ESCALATION_SIGNAL,
  NON_ESCALATION_SIGNAL,
  WEB_ESCALATION_MODE,
  createWebReasoningTelemetry,
  decideWebEscalation,
} from "../lib/web-reasoning-escalation.mjs"
import {
  WEB_LANE_LIMIT,
  advisorCapsuleFor,
  advisorTextFor,
  createWebReasoningLane,
} from "../lib/web-reasoning-lane.mjs"
import { WEB_REASONING_BOUNDS } from "../lib/deepseek-turn-policy-v16-6.mjs"
import { FOLLOW_UP_BUDGET, maySendSecondFollowUp } from "../lib/followup-budget.mjs"
import { prepareConsultationParallel } from "../lib/consult-prep.mjs"
import { DEFAULT_WEB_MODE, DEFAULT_WEB_ENABLED, WEB_CONFIG_MODE } from "../lib/deepseek-web-config.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// ---------------------------------------------------------------------------
// Part 8 - bounded proactive consultation policy: triggers + skip list.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 8: a substantive engineering task with a real trigger is consulted proactively", () => {
  const triggers = [
    "The verifier still fails and the root cause is ambiguous across the browser and mcp modules",
    "We need an architectural decision on how to split the controller and the lane",
    "There are several plausible fixes for this multi-subsystem regression",
    "I have low confidence about the right approach; a second opinion would help",
  ]
  for (const task of triggers) {
    const decision = decideWebEscalation({ mode: WEB_ESCALATION_MODE.AUTO, task })
    assert.equal(decision.escalate, true, `expected escalation for: ${task}`)
    assert.ok(decision.signals.length > 0, "an escalation must report its signals")
  }
})

test("V16.7.1 Part 8: the skip list keeps trivial / grounded work local", () => {
  const skips = [
    ["Bump the package version to 16.7.2", NON_ESCALATION_SIGNAL.VERSION_BUMP],
    ["Update the README and fix typos", NON_ESCALATION_SIGNAL.DOC_EDIT],
  ]
  for (const [task, signal] of skips) {
    const decision = decideWebEscalation({ mode: WEB_ESCALATION_MODE.AUTO, task })
    assert.equal(decision.escalate, false, `expected a skip for: ${task}`)
    assert.ok(decision.nonEscalationSignals.includes(signal), `${task} must report ${signal}`)
  }
})

test("V16.7.1 Part 8: an explicit skip signal (doc edit) vetoes a co-present escalation trigger in AUTO", () => {
  const decision = decideWebEscalation({
    mode: WEB_ESCALATION_MODE.AUTO,
    // Both a real trigger (ambiguous root cause) and a hard skip (doc edit).
    task: "Update the README to fix the ambiguous root cause across subsystems",
  })
  assert.equal(decision.escalate, false)
  assert.ok(decision.nonEscalationSignals.includes(NON_ESCALATION_SIGNAL.DOC_EDIT))
})

test("V16.7.1 Part 8: OFF never consults and FORCE is never the default posture", () => {
  const off = decideWebEscalation({ mode: WEB_ESCALATION_MODE.OFF, task: "ambiguous root cause across many subsystems" })
  assert.equal(off.escalate, false)
  assert.equal(off.reason, "web-reasoning-disabled")
})

// ---------------------------------------------------------------------------
// Part 9 - parallel read-only prep; no irreversible writes on incomplete advice.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 9: Lane A and Lane B run concurrently and are joined", async () => {
  const order = []
  const result = await prepareConsultationParallel({
    mode: "auto",
    laneA: async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 20)); order.push("a-end"); return "A" },
    laneB: async () => { order.push("b-start"); await new Promise((r) => setTimeout(r, 20)); order.push("b-end"); return "B" },
  })
  assert.equal(result.ok, true)
  assert.equal(result.laneA, "A")
  assert.equal(result.laneB, "B")
  // Both lanes started before either finished: that is the whole point.
  assert.ok(order.indexOf("a-start") < order.indexOf("b-end"))
  assert.ok(order.indexOf("b-start") < order.indexOf("a-end"))
  assert.equal(result.telemetry.parallel, true)
})

test("V16.7.1 Part 9: an incomplete lane never yields ok:true, and AUTO falls back to local", async () => {
  const result = await prepareConsultationParallel({
    mode: "auto",
    laneA: async () => { throw new Error("provider down") },
    laneB: async () => "B",
  })
  assert.equal(result.ok, false)
  assert.equal(result.fallbackToLocal, true)
  assert.equal(result.code, "CONSULT_PREP_FALLBACK_LOCAL")
})

test("V16.7.1 Part 9: FORCE turns an incomplete prep into WEB_REASONING_UNAVAILABLE, not a silent downgrade", async () => {
  const result = await prepareConsultationParallel({
    mode: "force",
    laneA: async () => { throw new Error("provider down") },
    laneB: async () => "B",
  })
  assert.equal(result.ok, false)
  assert.equal(result.fallbackToLocal, false)
  assert.equal(result.code, "WEB_REASONING_UNAVAILABLE")
})

// ---------------------------------------------------------------------------
// Part 10 - compact outbound packet accounting.
// ---------------------------------------------------------------------------

function fakeProviderDouble() {
  return {
    id: "deepseek-web",
    failureCodes: [],
    maxFollowUps: 2,
    capability: async () => ({ state: "ready", supportsFollowUp: true, sessionReusable: true }),
    startSession: async () => ({ sessionId: "s1", state: "ready" }),
    consult: async () => ({ answer: JSON.stringify({
      summary: "s",
      hypotheses: ["h"],
      recommendedApproach: ["a"],
      filesToInspect: ["lib/x.mjs"],
      risks: ["r"],
      verificationSuggestions: ["v"],
      confidence: 0.8,
    }) }),
    followUp: async () => ({ answer: JSON.stringify({ summary: "s2", hypotheses: ["h"], recommendedApproach: ["a"], filesToInspect: [], risks: [], verificationSuggestions: ["v"], confidence: 0.8 }) }),
    closeSession: async () => true,
  }
}

test("V16.7.1 Part 10: an accepted consult reports packetChars, packetFiles and packetEvidenceCount", async () => {
  const lane = createWebReasoningLane({ mode: "auto", adapters: [fakeProviderDouble()] })
  const result = await lane.consult({
    task: "ambiguous root cause across the browser and mcp modules",
    knownFiles: ["lib/x.mjs"],
    relevantFiles: [{ path: "lib/x.mjs", relevant: true }],
    evidence: [{ kind: "test", source: "npm test", text: "fail: retry budget 1, got 4" }],
  })
  assert.equal(result.outcome, "advised")
  assert.ok(result.packet.chars > 0, "packetChars must be reported")
  assert.ok(result.packet.files >= 1, "packetFiles must be reported")
  assert.equal(typeof result.packet.evidenceCount, "number")
  assert.ok(result.packet.evidenceCount >= 1, "packetEvidenceCount must count the evidence rows")
})

// ---------------------------------------------------------------------------
// Part 11 - compact advisor capsule.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 11: the compact capsule carries the bounded structured advice", () => {
  const capsule = advisorCapsuleFor({
    outcome: "advice-accepted",
    advice: {
      summary: "s",
      hypotheses: ["h1", "h2"],
      recommendedApproach: ["a1"],
      risks: ["r1"],
      edgeCases: ["e1"],
      verificationSuggestions: ["v1"],
      confidence: 0.82,
      evidenceBinding: { claims: [{ status: "present", path: "lib/x.mjs" }] },
    },
  })
  assert.equal(capsule.kind, "ues-advisor-capsule")
  assert.equal(capsule.trust, "untrusted-external")
  assert.equal(capsule.authority, "consultant-only")
  assert.deepEqual(capsule.hypotheses, ["h1", "h2"])
  assert.deepEqual(capsule.approach, ["a1"])
  assert.deepEqual(capsule.evidence, ["lib/x.mjs"])
  assert.deepEqual(capsule.risks, ["r1"])
  assert.deepEqual(capsule.alternatives, ["e1"])
  assert.deepEqual(capsule.questions, ["v1"])
  assert.equal(capsule.confidence, 0.82)
  assert.ok(capsule.chars > 0)
})

test("V16.7.1 Part 11: the capsule is null unless the advice was accepted, and it is bounded", () => {
  assert.equal(advisorCapsuleFor({ outcome: "advice-rejected", advice: { hypotheses: ["h"] } }), null)
  assert.equal(advisorCapsuleFor(null), null)
  const capsule = advisorCapsuleFor({
    outcome: "advice-accepted",
    advice: {
      hypotheses: Array.from({ length: 50 }, (_, i) => `h${i}`),
      recommendedApproach: Array.from({ length: 50 }, (_, i) => `a${i}`),
      risks: [], edgeCases: [], verificationSuggestions: [],
      confidence: 0.5,
    },
  })
  assert.ok(capsule.hypotheses.length <= 8)
  assert.ok(capsule.approach.length <= 10)
})

// ---------------------------------------------------------------------------
// Part 12 - consult early, at most one initial consult, one bounded follow-up.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 12: the lane allows exactly one initial consult and a bounded follow-up", () => {
  assert.equal(WEB_REASONING_BOUNDS.defaultMaxConsultations, 1)
  assert.equal(WEB_LANE_LIMIT.maxConsultations, 1)
  assert.equal(WEB_LANE_LIMIT.hardMaxConsultations, 3)
  assert.equal(FOLLOW_UP_BUDGET.defaultMaxFollowUps, 1)
  assert.equal(FOLLOW_UP_BUDGET.hardMaxFollowUps, 2)
  assert.equal(WEB_LANE_LIMIT.secondFollowUpRequiresFreshEvidence, true)
})

test("V16.7.1 Part 12: a second follow-up requires materially new evidence, never a re-send", () => {
  const stale = maySendSecondFollowUp(
    { followUpsSent: 1 },
    { freshVerifierEvidence: false, fingerprintChanged: false, firstResolved: false, benefitExceedsCost: false, submitBudgetAllows: true, sessionHealthy: true },
  )
  assert.equal(stale.allowed, false)
  const fresh = maySendSecondFollowUp(
    { followUpsSent: 1 },
    { freshVerifierEvidence: true, fingerprintChanged: true, firstResolved: false, benefitExceedsCost: true, submitBudgetAllows: true, sessionHealthy: true },
  )
  assert.equal(fresh.allowed, true)
})

test("V16.7.1 Part 12: the lane refuses a second consult on the same task (no budget widening)", async () => {
  const lane = createWebReasoningLane({ mode: "auto", adapters: [fakeProviderDouble()] })
  const input = {
    task: "ambiguous root cause across the browser and mcp modules",
    knownFiles: ["lib/x.mjs"],
    relevantFiles: [{ path: "lib/x.mjs", relevant: true }],
  }
  const first = await lane.consult(input)
  assert.equal(first.outcome, "advised")
  const second = await lane.consult(input)
  assert.equal(second.outcome, "skipped")
  assert.equal(second.reason, "consultation-budget-exhausted")
})

// ---------------------------------------------------------------------------
// Part 15 - lightweight, secret-free telemetry + structured journal fields.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 15: the telemetry snapshot is counters-only and never carries a secret", () => {
  const telemetry = createWebReasoningTelemetry()
  telemetry.bump("webReasoningCalls")
  telemetry.bump("decisionPacketChars", 1234)
  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.kind, "ues-web-reasoning-telemetry")
  assert.equal(snapshot.webReasoningCalls, 1)
  assert.equal(snapshot.decisionPacketChars, 1234)
  // Every field is a bounded counter/flag or an explicitly `estimated` number.
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "schemaVersion" || key === "kind") continue
    assert.ok(
      typeof value === "number" || value === null,
      `telemetry field ${key} must be a number or null, got ${typeof value}`,
    )
    assert.ok(!/token|cookie|password|secret|credential|storage/i.test(key) || /estimated/i.test(key), `telemetry field ${key} must not imply a secret`)
  }
  assert.equal(snapshot.estimatedTokensSent, null, "an unmeasured token count is null, not a guess")
})

test("V16.7.1 Part 15: the run journal records structured web-reasoning events without prose", () => {
  const cli = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8")
  for (const event of ["web-reasoning.consulted", "web-reasoning.unavailable"]) {
    assert.ok(cli.includes(event), `the journal must record ${event}`)
  }
  // Part 10 + 11: the consulted event carries the bounded accounting, never the
  // advisor prose itself.
  assert.ok(cli.includes("packetEvidenceCount: consultation?.packet?.evidenceCount ?? 0"))
  assert.ok(cli.includes("advisorCapsuleChars: consultation?.advisorCapsule?.chars ?? 0"))
  assert.ok(!cli.includes("advisorCapsule: consultation"), "the journal must not inline the advisor prose")
})

// ---------------------------------------------------------------------------
// Part 16 - benchmark honesty: NOT_MEASURED where unavailable.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 16: the A/B benchmark reports unmeasured tokens as null + reason, never a fabricated number", () => {
  const source = readFileSync(path.join(ROOT, "scripts", "bench-web-reasoning-ab.mjs"), "utf8")
  assert.ok(source.includes("NOT_MEASURED") || source.includes("piInputTokens: null"), "unavailable token metrics must be explicit")
  assert.ok(source.includes("measured: false"), "an unmeasured metric must carry measured:false")
  assert.ok(source.includes("no model provider is attached"), "the reason must say why it is unmeasured")
  // The comparison must not invent a delta when an arm is missing.
  assert.ok(source.includes("incomplete-measurement-no-conclusion"))
})

// ---------------------------------------------------------------------------
// Part 17 - README documents one-time setup, daily use and AUTO/OFF/FORCE.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 17: the README documents the daily flow and the three modes", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8")
  assert.ok(readme.includes("cd <project>; pi") || /cd\s+<project>.*pi/.test(readme), "the daily flow must be documented")
  assert.ok(readme.includes("`OFF`") && readme.includes("`AUTO`") && readme.includes("`FORCE`"), "all three modes must be documented")
  assert.ok(/ues doctor --reasoning/.test(readme), "the read-only readiness check must be documented")
})

test("V16.7.1 Part 17: the CLI exposes deepseek on/off/mode/status", () => {
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  for (const token of ["on|off", "mode [off|auto|force]", "status"]) {
    assert.ok(cli.includes(token), `the CLI usage must mention ${token}`)
  }
})

// ---------------------------------------------------------------------------
// Part 18 - FORCE is never the default.
// ---------------------------------------------------------------------------

test("V16.7.1 Part 18: the default persisted posture is AUTO, not FORCE", () => {
  assert.equal(DEFAULT_WEB_MODE, WEB_CONFIG_MODE.AUTO)
  assert.equal(DEFAULT_WEB_ENABLED, false)
  assert.notEqual(DEFAULT_WEB_MODE, WEB_CONFIG_MODE.FORCE)
})
