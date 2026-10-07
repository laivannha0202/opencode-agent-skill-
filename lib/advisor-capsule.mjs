// V16.9 advisor capsule.
//
// WHY THIS MODULE EXISTS
//
// V16.8 renders ONE executor-facing capsule per accepted consultation
// (`buildExecutorAdvisorCapsule` + `renderExecutorAdvisorCapsule`). That is
// correct for a single turn. But the advisor is now STATEFUL across a dialogue:
// a consult followed by a bounded follow-up can revise the plan. Two capsules
// rendered independently can contradict each other, and the executor has no
// single owner telling it which capsule is CURRENT and what changed between
// them.
//
// This module is that owner. It does NOT re-implement the V16.8 capsule: it
// delegates the field selection, target validation and budget shrink to the
// proven barrier functions, and adds only dialogue-level concerns:
//
//   * ONE current capsule per lifecycle (the newest accepted one wins);
//   * a bounded CHANGE note between the previous and current capsule, so the
//     executor sees what the follow-up revised without re-reading the whole plan;
//   * an honest receipt when a newer capsule is discarded (never silently keep
//     stale advice as if it were current).

import {
  buildExecutorAdvisorCapsule,
  renderExecutorAdvisorCapsule,
  V16_8_CAPSULE_MAX_CHARS,
} from "./web-decision-barrier-v16-8.mjs"

export const ADVISOR_CAPSULE_SCHEMA_VERSION = 1
export const ADVISOR_CAPSULE_POLICY = "advisor-capsule-v16-9"

function capsuleFiles(capsule) {
  const rows = capsule?.modelVisible?.files_to_touch
  return Array.isArray(rows) ? rows.map(String) : []
}

function capsuleSteps(capsule) {
  const rows = capsule?.modelVisible?.concrete_steps
  return Array.isArray(rows) ? rows.map(String) : []
}

/**
 * Diff two rendered capsules into a bounded "what changed" note. The note is a
 * set comparison only: it never paraphrases or reinterprets the advisor, so it
 * cannot introduce a claim the capsule did not already contain.
 */
export function capsuleChangeNote(previous, current) {
  if (!previous || !current) return null
  const prevFiles = new Set(capsuleFiles(previous))
  const curFiles = new Set(capsuleFiles(current))
  const addedFiles = [...curFiles].filter((value) => !prevFiles.has(value)).sort()
  const removedFiles = [...prevFiles].filter((value) => !curFiles.has(value)).sort()
  const prevSteps = capsuleSteps(previous)
  const curSteps = capsuleSteps(current)
  const stepsChanged = prevSteps.join("\n") !== curSteps.join("\n")
  const rootChanged = String(previous.modelVisible?.root_cause || "") !== String(current.modelVisible?.root_cause || "")
  const changed = addedFiles.length > 0 || removedFiles.length > 0 || stepsChanged || rootChanged
  return {
    changed,
    addedFiles,
    removedFiles,
    stepsChanged,
    rootChanged,
  }
}

/**
 * Create the dialogue-aware capsule owner for one advisor lifecycle.
 *
 * `build(result, prep, options)` produces a raw capsule exactly like V16.8.
 * `commit(capsule)` renders + accepts it as CURRENT, returning the bounded
 * change note against the previous current capsule.
 */
export function createAdvisorCapsuleOwner(options = {}) {
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(500, Math.min(V16_8_CAPSULE_MAX_CHARS, Number(options.maxChars)))
    : V16_8_CAPSULE_MAX_CHARS
  let current = null
  let currentText = null
  let revisions = 0
  let discards = 0
  const history = []

  function build(result, prep = {}, buildOptions = {}) {
    try {
      return buildExecutorAdvisorCapsule(result, prep, { maxChars, ...buildOptions })
    } catch {
      return null
    }
  }

  /**
   * Accept a freshly built capsule as the CURRENT one. A discarded capsule
   * never replaces the current one, and the receipt says so.
   */
  function commit(capsule, meta = {}) {
    if (!capsule || capsule.status !== "accepted") {
      discards += 1
      const receipt = {
        schemaVersion: ADVISOR_CAPSULE_SCHEMA_VERSION,
        kind: "ues-v16-9-advisor-capsule-receipt",
        policy: ADVISOR_CAPSULE_POLICY,
        accepted: false,
        reason: capsule?.reason || "capsule-not-accepted",
        supersedesCurrent: false,
        currentPreserved: current !== null,
        turn: meta.turn ?? null,
      }
      history.push(receipt)
      if (history.length > 16) history.shift()
      return receipt
    }
    const text = renderExecutorAdvisorCapsule(capsule)
    if (!text) {
      discards += 1
      const receipt = {
        schemaVersion: ADVISOR_CAPSULE_SCHEMA_VERSION,
        kind: "ues-v16-9-advisor-capsule-receipt",
        policy: ADVISOR_CAPSULE_POLICY,
        accepted: false,
        reason: "capsule-unrenderable",
        supersedesCurrent: false,
        currentPreserved: current !== null,
        turn: meta.turn ?? null,
      }
      history.push(receipt)
      if (history.length > 16) history.shift()
      return receipt
    }
    const change = current ? capsuleChangeNote(current, capsule) : null
    current = capsule
    currentText = text
    revisions += 1
    const receipt = {
      schemaVersion: ADVISOR_CAPSULE_SCHEMA_VERSION,
      kind: "ues-v16-9-advisor-capsule-receipt",
      policy: ADVISOR_CAPSULE_POLICY,
      accepted: true,
      reason: null,
      supersedesCurrent: change?.changed === true,
      currentPreserved: false,
      change,
      chars: text.length,
      turn: meta.turn ?? null,
    }
    history.push(receipt)
    if (history.length > 16) history.shift()
    return receipt
  }

  return {
    schemaVersion: ADVISOR_CAPSULE_SCHEMA_VERSION,
    policy: ADVISOR_CAPSULE_POLICY,
    maxChars,
    build,
    commit,
    /** The single current model-facing capsule, or null. */
    current() {
      return currentText
    },
    currentCapsule() {
      return current
    },
    state() {
      return {
        schemaVersion: ADVISOR_CAPSULE_SCHEMA_VERSION,
        policy: ADVISOR_CAPSULE_POLICY,
        revisions,
        discards,
        hasCurrent: current !== null,
        currentChars: currentText?.length || 0,
        history: history.slice(-6),
      }
    },
  }
}
