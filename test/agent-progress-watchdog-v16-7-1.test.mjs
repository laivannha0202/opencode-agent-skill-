// V16.7.1 agent generation-loop guard regression.
//
// The defect: a real long session degenerated into repetitive narration --
// "Let me write. Go." / "OK." / "Writing." -- with NO tool call, NO file
// change and NO phase advance, for thousands of turns. The model even emitted
// "I need to stop the loop." and kept looping. Nothing detected it.
//
// This file proves the guard the way the controller uses it:
//
//   1. The bounded watchdog classifies turns and NEVER trips on real progress
//      or on DISTINCT reasoning.
//   2. The exact pathological traces (repeated narration, declared intent with
//      no action, repeated compactions with no progress) ARE detected.
//   3. Recovery is bounded and fails closed with AGENT_LOOP_UNRECOVERED.
//   4. The checkpoint is bounded and carries only resumable state.
//   5. The SHIPPED extension really wires the watchdog into the parent hooks
//      (source contract), and exports nothing it does not use.

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AGENT_LOOP_LIMITS,
  AGENT_WATCHDOG_REASON,
  AGENT_WATCHDOG_STATUS,
  createAgentProgressWatchdog,
  declaresActionIntent,
  narrationFingerprint,
  normalizeNarration,
  renderLoopRecoveryInstruction,
} from "../lib/agent-progress-watchdog.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

// ---------------------------------------------------------------------------
// 1. Narration fingerprinting and intent detection (pure, bounded)
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard: the fingerprint collapses volatile ids and punctuation", () => {
  assert.equal(narrationFingerprint("Let me write."), narrationFingerprint("let me write!"))
  assert.equal(narrationFingerprint("Let me write."), narrationFingerprint("  LET ME WRITE  "))
  // A per-turn id or number must not defeat the fingerprint.
  assert.equal(narrationFingerprint("Let me write task 12345"), narrationFingerprint("Let me write task 99999"))
  assert.notEqual(narrationFingerprint("Let me write."), narrationFingerprint("Let me verify the output."))
  assert.equal(narrationFingerprint(""), "")
})

test("V16.7.1 loop guard: action intent is a short forward-looking declaration only", () => {
  assert.equal(declaresActionIntent("Let me write."), true)
  assert.equal(declaresActionIntent("Go."), true)
  assert.equal(declaresActionIntent("I'll run the tests now."), true)
  // A long analytical message that happens to contain "now" is NOT a declaration.
  assert.equal(declaresActionIntent("now " + "analysis ".repeat(200)), false)
  assert.equal(declaresActionIntent(""), false)
})

// ---------------------------------------------------------------------------
// 2. The guard must NEVER trip on legitimate work.
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard: a single long reasoning message never trips", () => {
  const watchdog = createAgentProgressWatchdog()
  const decision = watchdog.observeTurn("I analyzed the module graph and the failure is ambiguous; considering several hypotheses before acting.")
  assert.equal(decision.status, AGENT_WATCHDOG_STATUS.OK)
})

test("V16.7.1 loop guard: many DISTINCT reasoning messages with tool progress never trip", () => {
  const watchdog = createAgentProgressWatchdog()
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "one", "two", "three", "four"]
  for (const word of words) {
    watchdog.observeAction("tool-call")
    watchdog.observeAction("tool-completion")
    const decision = watchdog.observeTurn(`Reading a different file and reasoning about the ${word} subproblem.`)
    assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED, `${word} must not be a loop`)
  }
})

test("V16.7.1 loop guard: repeated chatter WITH tool progress never trips", () => {
  const watchdog = createAgentProgressWatchdog()
  for (let i = 0; i < 20; i += 1) {
    // Same words every turn, but a real tool call each time.
    watchdog.observeAction("tool-call")
    watchdog.observeAction("tool-completion")
    const decision = watchdog.observeTurn("Let me write.")
    assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED, `turn ${i} must not be a loop while tools progress`)
  }
})

test("V16.7.1 loop guard: a file mutation or phase transition resets the window", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.observeTurn("Let me write.")
  watchdog.observeTurn("Let me write.")
  watchdog.observeAction("file-mutation")
  const decision = watchdog.observeTurn("Let me write.")
  assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
})

// ---------------------------------------------------------------------------
// 3. The real pathological traces ARE detected.
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard: repeated identical narration with no progress is detected", () => {
  const watchdog = createAgentProgressWatchdog()
  let decision = null
  let detectedAt = -1
  for (let i = 0; i < 12; i += 1) {
    decision = watchdog.observeTurn("Let me write. Go.")
    if (decision.status === AGENT_WATCHDOG_STATUS.LOOP_DETECTED && detectedAt === -1) detectedAt = i
  }
  assert.equal(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
  // Repeated identical narration is caught by EITHER the repeated-narration rule
  // or the declared-intent rule; both are legitimate loop reasons.
  assert.ok(
    decision.reason === AGENT_WATCHDOG_REASON.GENERATION_LOOP || decision.reason === AGENT_WATCHDOG_REASON.TOOL_INTENT_STALLED,
    `unexpected reason ${decision.reason}`,
  )
  assert.ok(detectedAt >= 0 && detectedAt <= AGENT_LOOP_LIMITS.maxNoProgressTurns, `detected at turn ${detectedAt}`)
})

test("V16.7.1 loop guard: a declared action intent that never becomes an action is detected", () => {
  const watchdog = createAgentProgressWatchdog()
  let decision = null
  for (let i = 0; i < 8; i += 1) {
    // Distinct wording each turn, so only the intent stall can catch it.
    decision = watchdog.observeTurn(`Let me write the file number ${i} now.`)
  }
  assert.equal(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
  assert.equal(decision.reason, AGENT_WATCHDOG_REASON.TOOL_INTENT_STALLED)
  assert.equal(decision.declaredIntent, true)
})

test("V16.7.1 loop guard: a warning fires BEFORE the abort", () => {
  const watchdog = createAgentProgressWatchdog()
  // Genuinely distinct wording each turn, so ONLY the generic no-progress rule
  // can fire (the repeated-narration rule never sees a repeat).
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]
  const statuses = []
  for (const word of words) {
    statuses.push(watchdog.observeTurn(`Considering the ${word} hypothesis about the failing module without taking any action.`).status)
  }
  const firstWarning = statuses.indexOf(AGENT_WATCHDOG_STATUS.WARNING)
  const firstAbort = statuses.indexOf(AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
  assert.ok(firstWarning >= 0, "a warning must fire")
  assert.ok(firstAbort >= 0, "an abort must fire")
  assert.ok(firstWarning < firstAbort, "the warning must precede the abort")
})

test("V16.7.1 loop guard: repeated compactions with no progress are detected", () => {
  // One compaction early, then distinct narration with no action. The generic
  // no-progress rule is set high enough that the COMPACTION rule is the one that
  // must fire first (the compaction check precedes the generic check).
  const watchdog = createAgentProgressWatchdog({ maxCompactionsBeforeGuard: 1, maxNoProgressTurns: 4, warnNoProgressTurns: 3 })
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]
  let decision = null
  for (let i = 0; i < words.length; i += 1) {
    if (i === 0) watchdog.observeCompaction()
    decision = watchdog.observeTurn(`Considering the ${words[i]} hypothesis after a compaction, no action taken.`)
    if (decision.reason === AGENT_WATCHDOG_REASON.COMPACTION_NO_PROGRESS) break
  }
  assert.equal(decision.reason, AGENT_WATCHDOG_REASON.COMPACTION_NO_PROGRESS)
})

// ---------------------------------------------------------------------------
// 4. Bounded, fail-closed recovery.
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard: recovery is bounded and fails closed with AGENT_LOOP_UNRECOVERED", () => {
  const watchdog = createAgentProgressWatchdog({ maxLoopRecoveries: 2 })
  const first = watchdog.beginRecovery()
  const second = watchdog.beginRecovery()
  const third = watchdog.beginRecovery()
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(third.allowed, false, "recovery must fail closed after the ceiling")
  assert.equal(third.status, AGENT_WATCHDOG_STATUS.UNRECOVERED)
  assert.equal(third.reason, AGENT_WATCHDOG_REASON.UNRECOVERED)
  assert.equal(third.reason, "AGENT_LOOP_UNRECOVERED")
})

test("V16.7.1 loop guard: a recovery rotates the window so the fresh turn is judged alone", () => {
  const watchdog = createAgentProgressWatchdog()
  for (let i = 0; i < 6; i += 1) watchdog.observeTurn("Let me write. Go.")
  assert.equal(watchdog.isLoopConfirmed(), true)
  watchdog.beginRecovery()
  assert.equal(watchdog.isLoopConfirmed(), false, "a recovery must clear the confirmed-loop flag")
  const decision = watchdog.observeTurn("A single fresh narration.")
  assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
})

test("V16.7.1 loop guard: recovery resets on genuine progress and the loop does not recur", () => {
  const watchdog = createAgentProgressWatchdog()
  for (let i = 0; i < 6; i += 1) watchdog.observeTurn("Let me write. Go.")
  watchdog.beginRecovery()
  // Real action after the recovery.
  watchdog.observeAction("tool-call")
  watchdog.observeAction("tool-completion")
  watchdog.observeAction("file-mutation")
  const decision = watchdog.observeTurn("Applied the fix and now running the verifier.")
  assert.equal(decision.status, AGENT_WATCHDOG_STATUS.OK)
  // `progressed` is the ONLY signal the parent wiring uses to declare a
  // recovery COMPLETE; it must be true here and false when nothing moved.
  assert.equal(decision.progressed, true)
})

test("V16.7.1 loop guard: progressed distinguishes real action from narration", () => {
  const watchdog = createAgentProgressWatchdog()
  // A turn with no action progress must NOT report progressed.
  const stalled = watchdog.observeTurn("Let me write. Go.")
  assert.equal(stalled.progressed, false)
  // Any single real action must flip progressed true.
  watchdog.observeAction("tool-call")
  const acted = watchdog.observeTurn("Now editing the retry gate.")
  assert.equal(acted.progressed, true)
})

// ---------------------------------------------------------------------------
// 5. The checkpoint is bounded and resumable.
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard: the checkpoint is bounded and carries only resumable state", () => {
  const watchdog = createAgentProgressWatchdog({ maxCheckpointBytes: 2_048 })
  const checkpoint = watchdog.checkpoint({
    objective: "Fix the browser lane retry gate.",
    phase: "execute",
    changedFiles: Array.from({ length: 200 }, (_, i) => `lib/file-${i}.mjs`),
    completedVerification: ["npm test -- test/browser-lane.test.mjs"],
    remainingObjective: "Run the full verifier.",
    gitStatus: " M lib/browser-lane.mjs",
    blocker: "generation-loop-detected",
  })
  assert.equal(checkpoint.kind, "ues-agent-loop-checkpoint")
  assert.ok(checkpoint.bytes <= 2_048, `checkpoint must be bounded, got ${checkpoint.bytes}`)
  assert.ok(checkpoint.changedFiles.length <= 40, "changed files must be bounded")
  // No unbounded logs, prompts or secrets are present.
  assert.equal(typeof checkpoint.serialized, "string")
  assert.equal(checkpoint.serialized.length <= 2_048, true)
})

test("V16.7.1 loop guard: the recovery instruction forces action and resumes from the checkpoint", () => {
  const watchdog = createAgentProgressWatchdog()
  const checkpoint = watchdog.checkpoint({ objective: "Fix the retry gate.", phase: "execute" })
  const text = renderLoopRecoveryInstruction(checkpoint)
  assert.ok(text.includes("Stop narrating intent"))
  assert.ok(text.includes("Resume from the checkpoint"))
  assert.ok(text.includes("Fix the retry gate."))
  // It never authorizes a restart-from-zero.
  assert.ok(text.includes("Do not restart the task"))
})

// ---------------------------------------------------------------------------
// 6. The SHIPPED extension really wires the guard into the parent hooks.
// ---------------------------------------------------------------------------
test("V16.7.1 loop guard source: the parent hooks observe turns, actions and compactions", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes("createAgentProgressWatchdog("), "the extension must create the watchdog")
  assert.ok(source.includes("parentAgentWatchdog.observeTurn("), "message_end must classify each completed assistant turn")
  assert.ok(source.includes('parentAgentWatchdog.observeAction("tool-call")'), "tool_call must record action progress")
  assert.ok(source.includes('parentAgentWatchdog.observeAction("tool-completion")'), "tool_result must record completion progress")
  assert.ok(source.includes('parentAgentWatchdog.observeAction("file-mutation")'), "a write must record file-mutation progress")
  assert.ok(source.includes("parentAgentWatchdog.observeCompaction()"), "session_compact must record compactions")
  assert.ok(source.includes("parentAgentWatchdog.beginRecovery()"), "agent_before_settle must run the bounded recovery")
  assert.ok(source.includes("renderLoopRecoveryInstruction(checkpoint)"), "the recovery must inject the bounded instruction")
})

test("V16.7.1 loop guard source: the structured telemetry events are emitted", () => {
  const source = readFileSync(EXTENSION, "utf8")
  for (const event of [
    "agent.no-progress-warning",
    "agent.generation-loop-detected",
    "agent.loop-recovery-started",
    "agent.loop-recovery-completed",
    "agent.loop-recovery-failed",
  ]) {
    assert.ok(source.includes(`"${event}"`), `the extension must emit ${event}`)
  }
  assert.ok(source.includes("AGENT_LOOP_UNRECOVERED"), "the terminal unrecovered state must be present")
})

// ---------------------------------------------------------------------------
// 7. V16.7.1 Part 2: WITHIN-generation streaming loop detection.
//
// The turn-end guard only sees a completed assistant turn. A pathological
// generation can stream the SAME narration thousands of times BEFORE
// `message_end`, so by the time the turn-end guard fires the damage is already
// done. The streaming guard observes real `message_update` / `text_delta`
// events and can abort the CURRENT generation before it ends.
// ---------------------------------------------------------------------------
test("V16.7.1 stream guard: a legitimate long, DISTINCT stream never trips", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  let decision = null
  for (let i = 0; i < 500; i += 1) {
    decision = watchdog.observeStreamDelta(`analyzing module ${i} with a distinct reasoning step and a different conclusion each time `)
  }
  assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
  assert.equal(decision.abort, false)
})

test("V16.7.1 stream guard: a legitimate repeated CODE fragment never trips", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  let decision = null
  // Repetition without a declared ACTION intent (a code/JSON shape) must not be
  // treated as a narration loop.
  for (let i = 0; i < 200; i += 1) {
    decision = watchdog.observeStreamDelta("const value = compute(a, b); const next = other(c, d); ")
  }
  assert.notEqual(decision.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
})

test("V16.7.1 stream guard: a pathological narration stream warns then aborts EXACTLY once", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  const statuses = []
  let aborts = 0
  let warnedBeforeAbort = false
  let sawWarning = false
  for (let i = 0; i < 300; i += 1) {
    const decision = watchdog.observeStreamDelta("Let me write. Go. ")
    statuses.push(decision.status)
    if (decision.status === AGENT_WATCHDOG_STATUS.WARNING) sawWarning = true
    if (decision.abort === true) {
      aborts += 1
      if (sawWarning) warnedBeforeAbort = true
    }
  }
  assert.ok(statuses.includes(AGENT_WATCHDOG_STATUS.WARNING), "a streaming warning must fire")
  assert.equal(aborts, 1, "the controller must abort EXACTLY once per generation")
  assert.equal(warnedBeforeAbort, true, "the warning must precede the abort")
  assert.equal(watchdog.streamSnapshot().streamConfirmed, true)
  assert.equal(watchdog.streamSnapshot().streamAborts, 1)
})

// The EXACT production defect trace. A real session degenerated into a CYCLE of
// FIVE short phrases ("Let me write. / Go. / OK. / Writing. / Let me output."),
// not a single repeated phrase. Five phrases is NINE normalized word tokens, so
// token-period analysis alone (bounded at 4) can never see it; the phrase-level
// candidate is what closes the gap. This test fails on the pre-fix detector
// (warns=0, aborts=0) and passes only when the widened detector really trips.
test("V16.7.1 stream guard: the EXACT 5-phrase narration cycle warns then aborts exactly once", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  const cycle = ["Let me write.", "Go.", "OK.", "Writing.", "Let me output."]
  let aborts = 0
  let warnedBeforeAbort = false
  let sawWarning = false
  let firstWarningAt = -1
  let firstAbortAt = -1
  for (let i = 0; i < 400; i += 1) {
    const decision = watchdog.observeStreamDelta(`${cycle[i % cycle.length]} `)
    if (decision.status === AGENT_WATCHDOG_STATUS.WARNING) {
      if (firstWarningAt === -1) firstWarningAt = i
      sawWarning = true
    }
    if (decision.abort === true) {
      if (firstAbortAt === -1) firstAbortAt = i
      aborts += 1
      if (sawWarning) warnedBeforeAbort = true
    }
  }
  assert.ok(firstWarningAt >= 0, "the 5-phrase cycle must raise a streaming warning")
  assert.ok(firstAbortAt >= 0, "the 5-phrase cycle must be confirmed as a loop")
  assert.ok(firstWarningAt < firstAbortAt, "the warning must precede the abort")
  assert.equal(aborts, 1, "the controller must abort EXACTLY once per generation")
  assert.equal(warnedBeforeAbort, true)
  assert.equal(watchdog.streamSnapshot().streamConfirmed, true)
  assert.equal(watchdog.streamSnapshot().streamAborts, 1)
})

test("V16.7.1 stream guard: a long cycle of distinct-looking short phrases without intent never trips", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  // Repetition with NO action intent and NO imminence: an ordinary status/summary
  // loop of descriptive phrases is not the pathological narration defect.
  const cycle = ["The module exports a helper.", "The helper validates input.", "Validation returns a boolean."]
  let aborts = 0
  for (let i = 0; i < 400; i += 1) {
    const decision = watchdog.observeStreamDelta(`${cycle[i % cycle.length]} `)
    if (decision.abort === true) aborts += 1
  }
  assert.equal(aborts, 0, "descriptive repetition without action intent must not abort")
})

test("V16.7.1 stream guard: real tool progress mid-stream resets the window", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  for (let i = 0; i < 30; i += 1) watchdog.observeStreamDelta("Let me write. Go. ")
  // A real tool call ends this stream; the guard must not carry the repeats over.
  watchdog.observeAction("tool-call")
  const after = watchdog.observeStreamDelta("Now the fix is applied. ")
  assert.notEqual(after.status, AGENT_WATCHDOG_STATUS.LOOP_DETECTED)
  assert.equal(after.abort, false)
})

test("V16.7.1 stream guard: memory is bounded by the window, not the stream length", () => {
  const watchdog = createAgentProgressWatchdog({ streamWindowChars: 512 })
  watchdog.beginStream()
  for (let i = 0; i < 100_000; i += 1) watchdog.observeStreamDelta("x")
  const snapshot = watchdog.streamSnapshot()
  assert.ok(snapshot.streamChars > 90_000, "the char counter still counts the whole stream")
  assert.ok(snapshot.streamTailChars <= 512, `the retained tail must be bounded, got ${snapshot.streamTailChars}`)
})

test("V16.7.1 stream guard: beginStream clears the once-per-generation latch", () => {
  const watchdog = createAgentProgressWatchdog()
  watchdog.beginStream()
  for (let i = 0; i < 100; i += 1) watchdog.observeStreamDelta("Let me write. Go. ")
  assert.equal(watchdog.streamSnapshot().streamAborts, 1)
  watchdog.beginStream()
  const snapshot = watchdog.streamSnapshot()
  assert.equal(snapshot.streamAborts, 0)
  assert.equal(snapshot.streamConfirmed, false)
  assert.equal(snapshot.streamChars, 0)
})

// ---------------------------------------------------------------------------
// 8. V16.7.1 Part 2/3 source contract: the streaming hook and the widened scope.
// ---------------------------------------------------------------------------
test("V16.7.1 stream guard source: the extension observes message_update and aborts via ctx.abort()", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes('pi.on("message_start"'), "a generation start must reset the stream window")
  assert.ok(source.includes('pi.on("message_update"'), "the parent must observe the token stream")
  assert.ok(source.includes("assistantMessageEvent"), "the handler must read the streamed assistant event")
  assert.ok(source.includes('streamEvent.type !== "text_delta"'), "only text deltas are observed")
  assert.ok(source.includes("parentAgentWatchdog.observeStreamDelta("), "each delta must be observed")
  assert.ok(source.includes("ctx.abort()"), "a confirmed streaming loop must abort the current generation")
  // The abort must happen in the streaming handler, i.e. BEFORE message_end.
  const updateIndex = source.indexOf('pi.on("message_update"')
  const endIndex = source.indexOf('pi.on("message_end"')
  assert.ok(updateIndex >= 0 && endIndex > updateIndex, "message_update must be wired before message_end")
  const abortIndex = source.indexOf("ctx.abort()", updateIndex)
  assert.ok(abortIndex > updateIndex && abortIndex < endIndex, "the abort must live inside the streaming handler")
})

test("V16.7.1 Part 3 source: the loop guard scope is wider than uesModeActive but excludes casual chat", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes("const loopGuardActive = ()"), "the widened scope helper must exist")
  assert.ok(source.includes("uesModeActive() || parentEngineeringTurn || parentRunToolCalls > 0"), "the scope must include engineering turns and tool use")
  assert.ok(source.includes("automaticUesAdmission(text,"), "engineering classification must reuse the shipped admission policy")
  // The turn-end observation must use the widened scope.
  assert.ok(source.includes("if (text && loopGuardActive())"), "message_end must use the widened scope")
})
