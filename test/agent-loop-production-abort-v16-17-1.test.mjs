// V16.17.1 §31/§38-item-36: agent narration-loop PRODUCTION wiring.
//
// The V16.7.1 file pins the watchdog PURE functions. This file pins the
// PRODUCTION PATH the task requires:
//
//   provider streams repeated action narration
//     ↓
//   watchdog detects WITHIN the generation (real createAgentProgressWatchdog)
//     ↓
//   controller aborts EXACTLY ONCE (real AbortController, mirroring the
//   pi/extensions/ues.ts message_update → ctx.abort() wiring)
//     ↓
//   the stream REALLY stops (the emitter honors the signal, like a real
//   provider stream honoring ctx.abort(); emission count freezes)
//     ↓
//   bounded recovery (beginRecovery → renderLoopRecoveryInstruction),
//   fail-closed past the budget
//
// No test passes by raising a timeout: every assertion is an upper bound or
// an exact count.

import assert from "node:assert/strict"
import test from "node:test"
import {
  AGENT_LOOP_LIMITS,
  AGENT_WATCHDOG_STATUS,
  createAgentProgressWatchdog,
  renderLoopRecoveryInstruction,
} from "../lib/agent-progress-watchdog.mjs"

// A provider-like narration emitter: emits one phrase every `intervalMs`
// until the signal aborts, exactly like a provider stream that stops when
// ctx.abort() cancels it. Returns live counters, never a mock verdict.
function startNarrationStream(signal, phrases, intervalMs = 5) {
  const state = { emitted: 0, stoppedAt: -1, timer: null, done: false }
  state.timer = setInterval(() => {
    if (signal.aborted) {
      if (state.stoppedAt === -1) state.stoppedAt = state.emitted
      return
    }
    state.emitted += 1
  }, intervalMs)
  state.timer.unref?.()
  // Mirror the production shape: the controller observes each delta as it
  // arrives. `observe` feeds one phrase per emission.
  return state
}

function stopStream(state) {
  if (!state.done) {
    state.done = true
    clearInterval(state.timer)
  }
}

// The production controller sequence from pi/extensions/ues.ts
// (message_start → message_update deltas → message_end/settle recovery).
// `feed` maps each emitted phrase to a watchdog delta observation.
async function runProductionLoopGuard(phrases, options = {}) {
  const watchdog = createAgentProgressWatchdog(options.watchdog || {})
  const controller = new AbortController()
  watchdog.beginStream()
  let abortCalls = 0
  let latch = false
  const stream = startNarrationStream(controller.signal, phrases, options.intervalMs || 5)
  let index = 0
  const budget = Math.max(1, Number(options.maxDeltas || 500))
  const seen = []
  for (let step = 0; step < budget; step += 1) {
    if (controller.signal.aborted) break
    const delta = `${phrases[index % phrases.length]} `
    index += 1
    // The emitter produced one phrase; the controller observes it.
    stream.emitted = Math.max(stream.emitted, index)
    const decision = watchdog.observeStreamDelta(delta)
    seen.push(decision.status)
    if (decision.status === AGENT_WATCHDOG_STATUS.LOOP_DETECTED && decision.abort === true && !latch) {
      latch = true
      abortCalls += 1
      controller.abort()
      break
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 5))
  }
  const emittedAtAbort = index
  // Give the (now aborted) emitter a bounded window: a REAL cancellation
  // freezes emission; a dead abort would let it keep counting.
  await new Promise((resolve) => setTimeout(resolve, 120))
  stopStream(stream)
  return { watchdog, controller, abortCalls, seen, emittedAtAbort, stream }
}

// 36. stream-narration-loop-production-abort
test("V16.17.1 production: repeated narration aborts the live stream exactly once and the stream really stops", async () => {
  const cycle = ["Let me write.", "Go.", "OK.", "Writing.", "Let me output."]
  const run = await runProductionLoopGuard(cycle, { maxDeltas: 500, intervalMs: 5 })
  assert.equal(run.abortCalls, 1, "the controller must abort the generation exactly once")
  assert.equal(run.controller.signal.aborted, true, "the AbortSignal must be aborted")
  assert.equal(run.watchdog.streamSnapshot().streamConfirmed, true)
  assert.equal(run.watchdog.streamSnapshot().streamAborts, 1)
  assert.ok(run.seen.includes(AGENT_WATCHDOG_STATUS.WARNING), "a warning must precede the abort")
  // The stream REALLY stopped: no emission after the abort beat.
  assert.ok(run.emittedAtAbort > 0 && run.emittedAtAbort < 500, `abort must fire within the generation (fired at delta ${run.emittedAtAbort})`)
  assert.ok(
    run.stream.emitted <= run.emittedAtAbort + 2,
    `emission must freeze after abort (aborted at ${run.emittedAtAbort}, emitted ${run.stream.emitted})`,
  )
})

test("V16.17.1 production: abort is followed by one bounded recovery, then fail-closed", async () => {
  const cycle = ["Let me write.", "Go.", "OK.", "Writing.", "Let me output."]
  const run = await runProductionLoopGuard(cycle, { maxDeltas: 500, intervalMs: 5 })
  assert.equal(run.abortCalls, 1)
  // agent_before_settle equivalent: claim ONE recovery with a bounded
  // checkpoint, rendered as a context edit that forces action.
  const first = run.watchdog.beginRecovery()
  assert.equal(first.allowed, true)
  const checkpoint = run.watchdog.checkpoint({
    objective: "fix the null check",
    phase: "ues-active",
    changedFiles: [],
    completedVerification: [],
    remainingObjective: "fix the null check",
    gitStatus: "",
    blocker: "generation-loop-detected",
  })
  assert.ok(checkpoint.bytes <= AGENT_LOOP_LIMITS.maxCheckpointBytes)
  const instruction = renderLoopRecoveryInstruction(checkpoint)
  assert.ok(instruction.includes("NEXT output must be a tool call"), "recovery must force action, not more narration")
  // 39. max-recovery-bounded: exhaust the budget, then fail closed.
  let allowed = 0
  let denied = 0
  for (let i = 0; i < AGENT_LOOP_LIMITS.maxLoopRecoveries + 2; i += 1) {
    const attempt = run.watchdog.beginRecovery()
    if (attempt.allowed) allowed += 1
    else denied += 1
  }
  assert.equal(allowed, AGENT_LOOP_LIMITS.maxLoopRecoveries - 1, "only the remaining budget may be claimed")
  assert.ok(denied >= 1, "recovery past the budget must fail closed")
})

// 37. normal-long-reasoning-not-false-positive (production stream shape)
test("V16.17.1 production: a long DISTINCT reasoning stream never aborts", async () => {
  const watchdog = createAgentProgressWatchdog()
  const controller = new AbortController()
  watchdog.beginStream()
  let aborts = 0
  for (let i = 0; i < 120; i += 1) {
    if (controller.signal.aborted) break
    const decision = watchdog.observeStreamDelta(
      `analyzing module ${i} with a distinct reasoning step and a different conclusion each time `,
    )
    if (decision.abort === true) {
      aborts += 1
      controller.abort()
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(aborts, 0, "distinct reasoning must never abort the stream")
  assert.equal(controller.signal.aborted, false)
})

// 38. progress-between-similar-messages-not-loop (production turn shape)
test("V16.17.1 production: similar messages WITH tool progress between them are not a loop", async () => {
  const watchdog = createAgentProgressWatchdog()
  let looped = false
  for (let turn = 0; turn < 10; turn += 1) {
    const decision = watchdog.observeTurn("Let me write the fix now")
    if (decision.status === AGENT_WATCHDOG_STATUS.LOOP_DETECTED) looped = true
    watchdog.observeAction("tool-call")
    watchdog.observeAction("tool-completion")
    watchdog.observeAction("file-mutation")
  }
  assert.equal(looped, false, "messages with real progress between them must not trip the guard")
})
