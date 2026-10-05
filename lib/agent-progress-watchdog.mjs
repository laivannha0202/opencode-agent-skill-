// V16.7.1 agent generation-loop watchdog.
//
// Long real sessions produced a pathological failure mode that is NOT task
// execution: the assistant narrates that it is about to act ("Let me write.",
// "Go.", "OK.", "Writing.", "Let me output.") but NO tool call follows, NO file
// changes, NO phase advances. Thousands of repetitions were captured, and the
// model even emitted "I need to stop the loop." and kept looping.
//
// The deciding signal is NOT a vocabulary match. It is the ABSENCE OF STATE /
// ACTION PROGRESS combined with a REPEATED assistant-output fingerprint. A
// single legitimate long-reasoning message, or several DISTINCT reasoning
// messages, must never trip it. Repeated status chatter WHILE tools keep
// progressing must never trip it either.
//
// Everything here is bounded: a fixed-size rolling window, fixed-size counters,
// no timers, no background work, no unbounded arrays/maps. Detection returns a
// decision; it never performs a side effect, never touches git, and never
// deletes work.

import { createHash } from "node:crypto"

/** Safe, conservative defaults. All are overridable, all are clamped. */
export const AGENT_LOOP_LIMITS = Object.freeze({
  // Assistant turns with no action progress before a bounded warning.
  warnNoProgressTurns: 3,
  // Assistant turns with no action progress before the loop is confirmed.
  maxNoProgressTurns: 5,
  // Repeats of the SAME normalized narration before the loop is confirmed.
  maxRepeatedNarration: 3,
  // A declared "let me run/write/output" intent with no action within this many
  // subsequent turns is a stalled tool-intent.
  maxToolIntentStallTurns: 2,
  // Automatic recoveries of a detected loop before failing closed.
  maxLoopRecoveries: 2,
  // Recoveries after repeated compactions with no progress.
  maxCompactionRecoveries: 2,
  // Compactions before a no-progress compaction is treated as a recovery cause.
  maxCompactionsBeforeGuard: 2,
  // Upper bound on a serialized checkpoint.
  maxCheckpointBytes: 16_384,
  // Rolling window size (turns retained for fingerprinting).
  windowSize: 12,
  // --- V16.7.1 Part 2: WITHIN-generation streaming detection ---
  // Trailing repeated phrases within a SINGLE streamed generation before a
  // bounded warning. Detection happens DURING streaming, before `message_end`,
  // so the current generation can be aborted instead of waiting for the turn
  // to finish (by which time thousands of repeats were already emitted).
  warnStreamRepeats: 2,
  // Trailing repeated phrases before the current generation is a confirmed
  // loop and the controller aborts it.
  maxStreamRepeats: 3,
  // A streaming loop must accumulate at least this many characters before it
  // can trip; a short legitimate answer is never a loop.
  streamMinChars: 24,
  // Bounded tail buffer of the streamed text (chars). Memory is O(window).
  streamWindowChars: 4_096,
  // Maximum WORD-token period considered when matching a repeating tail. This
  // catches a single repeated phrase ("Let me write." xN, period 1) and a short
  // repeated two-phrase cycle ("Let me write. Go." xN, period 2).
  maxStreamPeriod: 4,
  // Maximum PHRASE period (sentences/clauses split on . ! ? and newlines). A
  // pathological narration loop can cycle through MORE than `maxStreamPeriod`
  // short sentences -- the real defect streamed
  // "Let me write. Go. OK. Writing. Let me output." (5 phrases / 9 tokens), which
  // a token-period bound of 4 can never see. The phrase-level candidate is what
  // closes that gap. Still bounded, so memory and cost stay O(window).
  maxStreamPhrasePeriod: 8,
  // Upper bound on the number of trailing phrases retained for analysis.
  streamMaxPhrases: 48,
  // Minimum tokens in a repeating trailing block before it counts as a loop.
  streamMinRepeatTokens: 2,
})

/** Closed vocabulary of watchdog decisions. */
export const AGENT_WATCHDOG_STATUS = Object.freeze({
  OK: "ok",
  WARNING: "warning",
  LOOP_DETECTED: "loop-detected",
  UNRECOVERED: "unrecovered",
})

/** Closed vocabulary of structured loop reasons. */
export const AGENT_WATCHDOG_REASON = Object.freeze({
  PROGRESS: "progress",
  NO_PROGRESS_WARNING: "agent-no-progress-warning",
  GENERATION_LOOP: "agent-generation-loop-detected",
  STREAM_LOOP_WARNING: "agent-stream-loop-warning",
  STREAM_LOOP: "agent-stream-loop-detected",
  TOOL_INTENT_STALLED: "agent-tool-intent-stalled",
  COMPACTION_NO_PROGRESS: "agent-compaction-no-progress",
  RECOVERED: "agent-loop-recovery-completed",
  UNRECOVERED: "AGENT_LOOP_UNRECOVERED",
})

// A declared imminent action. This is ONE signal, never the deciding one: it is
// only meaningful together with repeated turns and zero action progress.
const ACTION_INTENT = /\b(?:let me|i(?:'| a)?ll|i will|now|go|ok|okay|writing|write|output|produce|producing|emit|emitting|execute|executing|run|running|call|calling|invoke|invoking|apply|applying|create|creating|edit|editing|save|saving|submit|submitting)\b/i

function clampInt(value, fallback, min, max) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

/**
 * Normalize assistant narration to a stable fingerprint. Volatile IDs/numbers,
 * punctuation and whitespace are removed so "Let me write." and "Let me write!"
 * and "let me write" collapse to one fingerprint. Bounded to 2_000 chars so a
 * giant message cannot cost unbounded hashing.
 */
export function normalizeNarration(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .slice(0, 2_000)
    // Strip hex/uuid-ish and long numeric tokens (volatile per-turn ids).
    .replace(/\b[0-9a-f]{8,}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalized
}

export function narrationFingerprint(text) {
  const normalized = normalizeNarration(text)
  if (!normalized) return ""
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32)
}

/** Whether the text declares an imminent action ("let me run/write/output..."). */
export function declaresActionIntent(text) {
  const value = String(text || "")
  if (!value.trim()) return false
  // A declaration is short and forward-looking. A long analytical message that
  // happens to contain the word "now" is NOT a declaration.
  if (value.length > 600) return false
  return ACTION_INTENT.test(value)
}

function emptyCounters() {
  return {
    assistantTurns: 0,
    toolCalls: 0,
    toolCompletions: 0,
    fileMutations: 0,
    phaseTransitions: 0,
    verifications: 0,
    journalSeq: 0,
  }
}

function counterDelta(before, after) {
  return {
    toolCalls: Math.max(0, after.toolCalls - before.toolCalls),
    toolCompletions: Math.max(0, after.toolCompletions - before.toolCompletions),
    fileMutations: Math.max(0, after.fileMutations - before.fileMutations),
    phaseTransitions: Math.max(0, after.phaseTransitions - before.phaseTransitions),
    verifications: Math.max(0, after.verifications - before.verifications),
    journalSeq: Math.max(0, after.journalSeq - before.journalSeq),
  }
}

function anyProgress(delta) {
  return (
    delta.toolCalls > 0 ||
    delta.toolCompletions > 0 ||
    delta.fileMutations > 0 ||
    delta.phaseTransitions > 0 ||
    delta.verifications > 0 ||
    delta.journalSeq > 0
  )
}

/**
 * Count how many times the trailing block of `segments` repeats. A period `p`
 * means the last `p` segments form a block that is repeated consecutively; the
 * return value is the largest number of consecutive identical blocks across
 * every candidate period up to `maxPeriod`. This catches both a single repeated
 * phrase (`"Let me write."` xN, period 1) and a repeated two-phrase cycle
 * (`"Let me write. Go."` xN, period 2). Pure and bounded.
 */
export function trailingRepeatCount(segments, maxPeriod = 4) {
  const n = Array.isArray(segments) ? segments.length : 0
  let best = 1
  for (let period = 1; period <= maxPeriod; period += 1) {
    if (n < 2 * period) continue
    const block = segments.slice(n - period)
    if (block.some((segment) => !segment)) continue
    let repeats = 1
    for (let start = n - 2 * period; start >= 0; start -= period) {
      const previous = segments.slice(start, start + period)
      if (previous.length === period && previous.every((segment, index) => segment === block[index])) repeats += 1
      else break
    }
    if (repeats > best) best = repeats
  }
  return best
}

/**
 * Segment a bounded stream tail into normalized PHRASES (sentences/clauses split
 * on `. ! ?` and newlines) and keep only the trailing `maxPhrases`. Phrase-level
 * segmentation is what catches a cycle of MORE than `maxStreamPeriod` short
 * sentences -- the real defect streamed five distinct phrases
 * (`"Let me write. Go. OK. Writing. Let me output."`) which token-period
 * analysis alone can never see. Pure and bounded: at most `maxPhrases` entries.
 */
export function trailingPhraseSegments(tail, maxPhrases = 48) {
  const parts = String(tail || "").split(/[.!?\n]+/)
  const segments = []
  for (let index = parts.length - 1; index >= 0 && segments.length < maxPhrases; index -= 1) {
    const normalized = normalizeNarration(parts[index])
    if (normalized) segments.unshift(normalized)
  }
  return segments
}

/**
 * Choose the strongest ACTION-INTENT repetition candidate for a bounded stream
 * tail. Two bounded candidates are considered and the one with the most repeats
 * wins:
 *
 *   1. WORD-token trailing repetition (period up to `maxStreamPeriod`), which
 *      catches `"Let me write."` xN and `"Let me write. Go."` xN.
 *   2. PHRASE trailing repetition (period up to `maxStreamPhrasePeriod`), which
 *      catches a longer cycle of short sentences that the token bound cannot.
 *
 * A candidate only qualifies when its repeating block is a declared imminent
 * action of at least `streamMinRepeatTokens` tokens, so a repeated CODE fragment,
 * a JSON shape or ordinary prose repetition is never treated as a narration
 * loop. Returns `{ repeats, tokens }`; `tokens` is empty when nothing qualifies.
 */
export function bestStreamRepeatCandidate(tail, limits) {
  const maxPeriod = Number(limits?.maxStreamPeriod) || 4
  const maxPhrasePeriod = Number(limits?.maxStreamPhrasePeriod) || 8
  const maxPhrases = Number(limits?.streamMaxPhrases) || 48
  const minTokens = Number(limits?.streamMinRepeatTokens) || 2
  let best = { repeats: 1, tokens: [] }

  const consider = (segments, maxSegPeriod) => {
    const repeats = trailingRepeatCount(segments, maxSegPeriod)
    if (repeats < 2) return
    const period = Math.min(maxSegPeriod, Math.floor(segments.length / repeats))
    if (period <= 0) return
    const block = segments.slice(segments.length - period)
    const blockText = block.join(" ").trim()
    const tokens = blockText ? blockText.split(" ").filter(Boolean) : []
    if (tokens.length < minTokens) return
    if (!declaresActionIntent(blockText)) return
    if (repeats > best.repeats) best = { repeats, tokens }
  }

  const normalized = normalizeNarration(tail)
  consider(normalized ? normalized.split(" ") : [], maxPeriod)
  consider(trailingPhraseSegments(tail, maxPhrases), maxPhrasePeriod)
  return best
}

/**
 * Create a bounded watchdog for ONE agent loop (one controller run / session).
 *
 * The caller feeds it (a) completed assistant turns via `observeTurn` and (b)
 * action events via `observeAction`. Counters are monotonic; the watchdog
 * compares snapshots so it never needs the caller to compute deltas.
 */
export function createAgentProgressWatchdog(options = {}) {
  const limits = {
    warnNoProgressTurns: clampInt(options.warnNoProgressTurns, AGENT_LOOP_LIMITS.warnNoProgressTurns, 2, 50),
    maxNoProgressTurns: clampInt(options.maxNoProgressTurns, AGENT_LOOP_LIMITS.maxNoProgressTurns, 3, 100),
    maxRepeatedNarration: clampInt(options.maxRepeatedNarration, AGENT_LOOP_LIMITS.maxRepeatedNarration, 2, 50),
    maxToolIntentStallTurns: clampInt(options.maxToolIntentStallTurns, AGENT_LOOP_LIMITS.maxToolIntentStallTurns, 1, 20),
    maxLoopRecoveries: clampInt(options.maxLoopRecoveries, AGENT_LOOP_LIMITS.maxLoopRecoveries, 0, 10),
    maxCompactionRecoveries: clampInt(options.maxCompactionRecoveries, AGENT_LOOP_LIMITS.maxCompactionRecoveries, 0, 10),
    maxCompactionsBeforeGuard: clampInt(options.maxCompactionsBeforeGuard, AGENT_LOOP_LIMITS.maxCompactionsBeforeGuard, 1, 20),
    maxCheckpointBytes: clampInt(options.maxCheckpointBytes, AGENT_LOOP_LIMITS.maxCheckpointBytes, 512, 200_000),
    windowSize: clampInt(options.windowSize, AGENT_LOOP_LIMITS.windowSize, 4, 100),
    warnStreamRepeats: clampInt(options.warnStreamRepeats, AGENT_LOOP_LIMITS.warnStreamRepeats, 2, 50),
    maxStreamRepeats: clampInt(options.maxStreamRepeats, AGENT_LOOP_LIMITS.maxStreamRepeats, 2, 100),
    streamMinChars: clampInt(options.streamMinChars, AGENT_LOOP_LIMITS.streamMinChars, 8, 100_000),
    streamWindowChars: clampInt(options.streamWindowChars, AGENT_LOOP_LIMITS.streamWindowChars, 256, 200_000),
    maxStreamPeriod: clampInt(options.maxStreamPeriod, AGENT_LOOP_LIMITS.maxStreamPeriod, 1, 16),
    maxStreamPhrasePeriod: clampInt(options.maxStreamPhrasePeriod, AGENT_LOOP_LIMITS.maxStreamPhrasePeriod, 1, 24),
    streamMaxPhrases: clampInt(options.streamMaxPhrases, AGENT_LOOP_LIMITS.streamMaxPhrases, 8, 256),
    streamMinRepeatTokens: clampInt(options.streamMinRepeatTokens, AGENT_LOOP_LIMITS.streamMinRepeatTokens, 1, 16),
  }
  // `maxNoProgressTurns` must never be below the warning threshold, or the
  // warning would never fire before the abort.
  if (limits.maxNoProgressTurns < limits.warnNoProgressTurns) {
    limits.maxNoProgressTurns = limits.warnNoProgressTurns
  }

  const counters = emptyCounters()
  /** Bounded rolling window of `{ fingerprint, intent, turnsWithoutProgress }`. */
  const window = []
  let lastFingerprint = ""
  let repeatedFingerprintCount = 0
  let turnsWithoutProgress = 0
  let toolIntentStallTurns = 0
  let recoveryAttempts = 0
  let compactionCount = 0
  let compactionRecoveries = 0
  let lastCompactionAtTurn = -1
  let confirmedLoop = false
  // --- V16.7.1 Part 2: WITHIN-generation streaming state (bounded) ---
  // The trailing streamed text (bounded to `limits.streamWindowChars`). Only the
  // tail matters for a repeating-phrase match, so memory is O(window), not
  // O(generation length).
  let streamTail = ""
  // Total chars streamed in the CURRENT generation (bounded counter).
  let streamChars = 0
  // Whether the current generation has already been confirmed as a loop, so
  // the controller aborts EXACTLY ONCE per generation.
  let streamConfirmed = false
  // Whether the warning was already emitted for the current generation.
  let streamWarned = false
  // Number of aborts requested in the CURRENT generation (observable).
  let streamAborts = 0
  // Cumulative aborts across the session (never reset by `beginStream`).
  let streamAbortsTotal = 0
  // Highest trailing-repeat count observed in the current generation.
  let streamMaxRepeats = 1
  let lastDecision = {
    status: AGENT_WATCHDOG_STATUS.OK,
    reason: AGENT_WATCHDOG_REASON.PROGRESS,
    progressed: false,
    turnsWithoutProgress: 0,
    repeatedFingerprintCount: 0,
    toolCallsDelta: 0,
    toolCompletionsDelta: 0,
    phaseChanged: false,
    filesChanged: 0,
    recoveryAttempt: recoveryAttempts,
  }
  let previousCounters = { ...counters }

  function record(delta, extra = {}) {
    const decision = {
      status: AGENT_WATCHDOG_STATUS.OK,
      reason: AGENT_WATCHDOG_REASON.PROGRESS,
      progressed: false,
      turnsWithoutProgress,
      repeatedFingerprintCount,
      toolCallsDelta: delta.toolCalls,
      toolCompletionsDelta: delta.toolCompletions,
      filesChanged: delta.fileMutations,
      phaseChanged: delta.phaseTransitions > 0,
      recoveryAttempt: recoveryAttempts,
      ...extra,
    }
    lastDecision = decision
    return decision
  }

  return {
    limits,

    /**
     * V16.7.1 Part 2: reset the WITHIN-generation streaming state. Called when a
     * new assistant generation starts (or after a tool call ends the previous
     * one), so a fresh generation is judged on its own stream.
     */
    beginStream() {
      streamTail = ""
      streamChars = 0
      streamConfirmed = false
      streamWarned = false
      streamMaxRepeats = 1
      streamAborts = 0
    },

    /**
     * V16.7.1 Part 2: observe ONE streamed text delta (`message_update` /
     * `text_delta`). Detection happens DURING streaming so the current
     * generation can be aborted BEFORE `message_end`, instead of only after a
     * turn completes (by which time thousands of repeats were already emitted).
     *
     * The rule is narrow on purpose: a trailing block of at least
     * `streamMinRepeatTokens` tokens that (a) DECLARES an imminent action and
     * (b) repeats at least `maxStreamRepeats` times consecutively, after at
     * least `streamMinChars` characters, is a streaming loop. A legitimate long
     * answer, a code block, or any stream with real tool progress never trips it.
     *
     * Returns `{ status, reason, repeats, streamChars, abort }`. `abort` is true
     * at most ONCE per generation, so the caller aborts exactly once.
     */
    observeStreamDelta(delta = "") {
      const chunk = typeof delta === "string" ? delta : ""
      if (!chunk) {
        return { status: AGENT_WATCHDOG_STATUS.OK, reason: AGENT_WATCHDOG_REASON.PROGRESS, repeats: streamMaxRepeats, streamChars, abort: false }
      }
      streamChars += chunk.length
      streamTail += chunk
      if (streamTail.length > limits.streamWindowChars) {
        streamTail = streamTail.slice(streamTail.length - limits.streamWindowChars)
      }
      if (streamConfirmed) {
        // Already decided to abort this generation: never count a second abort.
        return { status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED, reason: AGENT_WATCHDOG_REASON.STREAM_LOOP, repeats: streamMaxRepeats, streamChars, abort: false }
      }
      if (streamChars < limits.streamMinChars) {
        return { status: AGENT_WATCHDOG_STATUS.OK, reason: AGENT_WATCHDOG_REASON.PROGRESS, repeats: streamMaxRepeats, streamChars, abort: false }
      }
      // Find the strongest ACTION-INTENT repetition candidate for the bounded
      // tail. Two bounded candidates are considered (word-token period and
      // phrase period); a candidate only qualifies when its repeating block is a
      // declared imminent action, so an ordinary repeated code fragment or prose
      // repetition never trips the guard.
      const candidate = bestStreamRepeatCandidate(streamTail, limits)
      const repeats = candidate.repeats
      if (repeats > streamMaxRepeats) streamMaxRepeats = repeats
      if (repeats < limits.warnStreamRepeats) {
        return { status: AGENT_WATCHDOG_STATUS.OK, reason: AGENT_WATCHDOG_REASON.PROGRESS, repeats, streamChars, abort: false }
      }
      const intent = candidate.tokens.length >= limits.streamMinRepeatTokens
      if (repeats >= limits.maxStreamRepeats && intent) {
        streamConfirmed = true
        streamAborts += 1
        streamAbortsTotal += 1
        confirmedLoop = true
        lastDecision = {
          ...lastDecision,
          status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED,
          reason: AGENT_WATCHDOG_REASON.STREAM_LOOP,
          streamRepeats: repeats,
          streamChars,
        }
        return { status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED, reason: AGENT_WATCHDOG_REASON.STREAM_LOOP, repeats, streamChars, abort: true }
      }
      if (!streamWarned && intent) {
        streamWarned = true
        return { status: AGENT_WATCHDOG_STATUS.WARNING, reason: AGENT_WATCHDOG_REASON.STREAM_LOOP_WARNING, repeats, streamChars, abort: false }
      }
      return { status: AGENT_WATCHDOG_STATUS.OK, reason: AGENT_WATCHDOG_REASON.PROGRESS, repeats, streamChars, abort: false }
    },

    /** Bounded, read-only snapshot of the streaming guard state. */
    streamSnapshot() {
      return {
        streamChars,
        streamTailChars: streamTail.length,
        streamConfirmed,
        streamWarned,
        streamAborts,
        streamAbortsTotal,
        streamMaxRepeats,
      }
    },

    /** Record a tool/action event. Any of these is real progress. */
    observeAction(kind, amount = 1) {
      const increment = clampInt(amount, 1, 1, 10_000)
      if (kind === "tool-call") counters.toolCalls += increment
      else if (kind === "tool-completion") counters.toolCompletions += increment
      else if (kind === "file-mutation") counters.fileMutations += increment
      else if (kind === "phase-transition") counters.phaseTransitions += increment
      else if (kind === "verification") counters.verifications += increment
      else if (kind === "journal") counters.journalSeq += increment
      // Real action progress ends the current stream: a generation that emitted
      // a tool call is not a narration loop. Rotate the streaming window so the
      // next generation is judged alone.
      if (kind === "tool-call" || kind === "tool-completion" || kind === "file-mutation") {
        streamTail = ""
        streamConfirmed = false
        streamWarned = false
        streamMaxRepeats = 1
      }
    },

    /** Record a completed compaction. */
    observeCompaction() {
      compactionCount += 1
      lastCompactionAtTurn = counters.assistantTurns
    },

    /**
     * Record one completed assistant turn and return the watchdog decision.
     * `text` is the assistant message; action counters are compared against the
     * previous turn to decide whether ANYTHING moved.
     */
    observeTurn(text = "") {
      counters.assistantTurns += 1
      const delta = counterDelta(previousCounters, counters)
      previousCounters = { ...counters }
      const progressed = anyProgress(delta)

      const fingerprint = narrationFingerprint(text)
      const intent = declaresActionIntent(text)

      if (progressed) {
        // Real action progress resets EVERY no-progress accumulator. A loop
        // that resumes work is not a loop.
        turnsWithoutProgress = 0
        toolIntentStallTurns = 0
        repeatedFingerprintCount = 0
        confirmedLoop = false
        lastFingerprint = fingerprint
      } else {
        turnsWithoutProgress += 1
        if (fingerprint && fingerprint === lastFingerprint) repeatedFingerprintCount += 1
        else {
          lastFingerprint = fingerprint
          repeatedFingerprintCount = fingerprint ? 1 : 0
        }
        if (intent) toolIntentStallTurns += 1
        else toolIntentStallTurns = 0
      }

      // Bounded rolling window. Only the tail matters for detection.
      window.push({ fingerprint, intent, turnsWithoutProgress, progressed })
      while (window.length > limits.windowSize) window.shift()

      if (progressed) return record(delta, { progressed: true, reason: AGENT_WATCHDOG_REASON.PROGRESS })

      // 1. Declared action intent that never becomes an action.
      if (intent && toolIntentStallTurns >= limits.maxToolIntentStallTurns && turnsWithoutProgress >= limits.maxToolIntentStallTurns) {
        confirmedLoop = true
        return record(delta, {
          status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED,
          reason: AGENT_WATCHDOG_REASON.TOOL_INTENT_STALLED,
          declaredIntent: true,
        })
      }

      // 2. Repeated identical narration with no progress.
      if (repeatedFingerprintCount >= limits.maxRepeatedNarration && turnsWithoutProgress >= limits.maxRepeatedNarration) {
        confirmedLoop = true
        return record(delta, {
          status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED,
          reason: AGENT_WATCHDOG_REASON.GENERATION_LOOP,
          repeatedNarration: repeatedFingerprintCount,
        })
      }

      // 3. Repeated compactions with no progress after the last one.
      if (
        compactionCount >= limits.maxCompactionsBeforeGuard &&
        lastCompactionAtTurn >= 0 &&
        counters.assistantTurns - lastCompactionAtTurn >= limits.maxNoProgressTurns
      ) {
        confirmedLoop = true
        return record(delta, {
          status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED,
          reason: AGENT_WATCHDOG_REASON.COMPACTION_NO_PROGRESS,
          compactions: compactionCount,
        })
      }

      // 4. Generic no-progress: narration grows, nothing else moves.
      if (turnsWithoutProgress >= limits.maxNoProgressTurns) {
        confirmedLoop = true
        return record(delta, {
          status: AGENT_WATCHDOG_STATUS.LOOP_DETECTED,
          reason: AGENT_WATCHDOG_REASON.GENERATION_LOOP,
        })
      }

      if (turnsWithoutProgress >= limits.warnNoProgressTurns) {
        return record(delta, {
          status: AGENT_WATCHDOG_STATUS.WARNING,
          reason: AGENT_WATCHDOG_REASON.NO_PROGRESS_WARNING,
        })
      }

      return record(delta)
    },

    /**
     * Claim one automatic recovery. Returns `{ allowed, attempt, reason }`.
     * Once the ceiling is reached the watchdog fails closed and never restarts
     * again.
     */
    beginRecovery() {
      if (recoveryAttempts >= limits.maxLoopRecoveries) {
        return {
          allowed: false,
          attempt: recoveryAttempts,
          status: AGENT_WATCHDOG_STATUS.UNRECOVERED,
          reason: AGENT_WATCHDOG_REASON.UNRECOVERED,
        }
      }
      recoveryAttempts += 1
      // A recovery rotates context: clear the loop accumulators so the fresh
      // turn is judged on its own behavior, not the dead one.
      turnsWithoutProgress = 0
      toolIntentStallTurns = 0
      repeatedFingerprintCount = 0
      confirmedLoop = false
      lastFingerprint = ""
      window.length = 0
      previousCounters = { ...counters }
      // A recovery rotates the STREAMING window too: the fresh generation is
      // judged on its own stream, not the dead one.
      streamTail = ""
      streamChars = 0
      streamConfirmed = false
      streamWarned = false
      streamMaxRepeats = 1
      return {
        allowed: true,
        attempt: recoveryAttempts,
        maxRecoveries: limits.maxLoopRecoveries,
        status: AGENT_WATCHDOG_STATUS.OK,
        reason: "agent-loop-recovery-started",
      }
    },

    /** Whether a loop is currently confirmed. */
    isLoopConfirmed() {
      return confirmedLoop
    },

    /**
     * Build a compact, bounded checkpoint. It carries ONLY what a fresh
     * continuation needs to resume: the objective, phase, changed files,
     * completed verification, remaining objective, git status summary and the
     * blocker. It NEVER carries a full prompt, credentials or unbounded logs.
     */
    checkpoint(input = {}) {
      const rows = {
        schemaVersion: 1,
        kind: "ues-agent-loop-checkpoint",
        createdAt: new Date(Number(input.now) || Date.now()).toISOString(),
        objective: String(input.objective || "").slice(0, 1_000),
        phase: String(input.phase || "").slice(0, 200),
        changedFiles: (Array.isArray(input.changedFiles) ? input.changedFiles : [])
          .map((row) => String(row).slice(0, 300))
          .slice(0, 40),
        completedVerification: (Array.isArray(input.completedVerification) ? input.completedVerification : [])
          .map((row) => String(row).slice(0, 300))
          .slice(0, 20),
        remainingObjective: String(input.remainingObjective || "").slice(0, 1_000),
        gitStatus: String(input.gitStatus || "").slice(0, 1_000),
        blocker: String(input.blocker || "").slice(0, 500),
        loopReason: String(lastDecision.reason || ""),
        turnsWithoutProgress,
        recoveryAttempt: recoveryAttempts,
        maxRecoveries: limits.maxLoopRecoveries,
      }
      let serialized = JSON.stringify(rows)
      if (serialized.length > limits.maxCheckpointBytes) {
        serialized = serialized.slice(0, limits.maxCheckpointBytes)
      }
      return { ...rows, bytes: serialized.length, serialized }
    },

    snapshot() {
      return {
        schemaVersion: 1,
        kind: "ues-agent-progress-watchdog",
        limits,
        counters: { ...counters },
        turnsWithoutProgress,
        toolIntentStallTurns,
        repeatedFingerprintCount,
        recoveryAttempts,
        compactionCount,
        compactionRecoveries,
        loopConfirmed: confirmedLoop,
        windowSize: window.length,
        stream: {
          chars: streamChars,
          tailChars: streamTail.length,
          confirmed: streamConfirmed,
          warned: streamWarned,
          aborts: streamAborts,
          abortsTotal: streamAbortsTotal,
          maxRepeats: streamMaxRepeats,
        },
        lastDecision: { ...lastDecision },
      }
    },

    /** Clear all loop state for a genuinely fresh run. */
    reset() {
      Object.assign(counters, emptyCounters())
      window.length = 0
      lastFingerprint = ""
      repeatedFingerprintCount = 0
      turnsWithoutProgress = 0
      toolIntentStallTurns = 0
      recoveryAttempts = 0
      compactionCount = 0
      compactionRecoveries = 0
      lastCompactionAtTurn = -1
      confirmedLoop = false
      streamTail = ""
      streamChars = 0
      streamConfirmed = false
      streamWarned = false
      streamMaxRepeats = 1
      streamAborts = 0
      streamAbortsTotal = 0
      previousCounters = { ...counters }
      lastDecision = {
        status: AGENT_WATCHDOG_STATUS.OK,
        reason: AGENT_WATCHDOG_REASON.PROGRESS,
        progressed: false,
        turnsWithoutProgress: 0,
        repeatedFingerprintCount: 0,
        toolCallsDelta: 0,
        toolCompletionsDelta: 0,
        phaseChanged: false,
        filesChanged: 0,
        recoveryAttempt: 0,
      }
    },
  }
}

/**
 * The bounded recovery instruction injected after a confirmed loop. It carries
 * the checkpoint and demands a deterministic action instead of more narration.
 * It is a CONTEXT EDIT, never a permission and never a restart-from-zero.
 */
export function renderLoopRecoveryInstruction(checkpoint = {}) {
  const lines = [
    "UES agent loop guard: repeated narration with no action progress was detected.",
    "Stop narrating intent. The NEXT output must be a tool call or a final answer.",
    "Do not restart the task. Resume from the checkpoint below.",
    "",
    "Checkpoint:",
    `- objective: ${String(checkpoint.objective || "(unknown)").slice(0, 300)}`,
    `- phase: ${String(checkpoint.phase || "(unknown)")}`,
    `- changed files: ${(checkpoint.changedFiles || []).slice(0, 10).join(", ") || "(none)"}`,
    `- completed verification: ${(checkpoint.completedVerification || []).slice(0, 5).join("; ") || "(none)"}`,
    `- remaining: ${String(checkpoint.remainingObjective || "(unknown)").slice(0, 300)}`,
    `- blocker: ${String(checkpoint.blocker || "(none)")}`,
    "",
    "If you cannot act, return a final answer that states the blocker explicitly.",
  ]
  return lines.join("\n")
}
