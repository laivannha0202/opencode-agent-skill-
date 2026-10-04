// V16.4 Slice E: adaptive Decision Packet tiers.
//
// The 48k ceiling stays as an emergency upper bound only. The router picks the
// smallest sufficient tier and follow-ups expand only the missing sections:
//
//   SMALL  ~6k-10k chars    trivial / single-subsystem / grounded
//   MEDIUM ~12k-20k chars   multi-file / some ambiguity
//   LARGE  ~24k-36k chars   architectural / multi-subsystem / verifier history
//
// Essential sections (original task, requirement summary, constraints,
// verification expectations) are never dropped.

import { DECISION_PACKET_SECTION } from "./decision-packet.mjs";

export const PACKET_TIER = Object.freeze({
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
});

export const PACKET_TIER_BUDGET = Object.freeze({
  [PACKET_TIER.SMALL]: { maxPacketChars: 10_000, maxFiles: 6, maxSnippets: 3, maxEvidence: 3, maxDiffChars: 3_000 },
  [PACKET_TIER.MEDIUM]: { maxPacketChars: 20_000, maxFiles: 12, maxSnippets: 6, maxEvidence: 6, maxDiffChars: 6_000 },
  [PACKET_TIER.LARGE]: { maxPacketChars: 36_000, maxFiles: 24, maxSnippets: 12, maxEvidence: 10, maxDiffChars: 12_000 },
});

export const PACKET_EMERGENCY_CEILING_CHARS = 48_000;

/**
 * Pick the smallest sufficient tier. Deterministic; every input is a measured
 * or declared quantity, never a model judgement.
 */
export function selectPacketTier(input = {}) {
  const subsystems = Number(input.affectedSubsystems || 0);
  const evidence = Number(input.evidenceCount || 0);
  const diffChars = Number(input.diffChars || 0);
  const retries = Number(input.verifierRetries || 0);
  const questions = Number(input.unresolvedQuestions || 0);
  if (
    input.architecturalWork === true ||
    subsystems >= 3 ||
    retries >= 2 ||
    questions >= 3 ||
    diffChars > 12_000 ||
    evidence > 12
  ) {
    return PACKET_TIER.LARGE;
  }
  if (
    input.ambiguous === true ||
    subsystems >= 2 ||
    retries >= 1 ||
    questions >= 1 ||
    diffChars > 3_000 ||
    evidence > 4
  ) {
    return PACKET_TIER.MEDIUM;
  }
  return PACKET_TIER.SMALL;
}

const tierCounters = {
  packetTier: null,
  packetChars: 0,
  packetFiles: 0,
  packetSectionsSent: 0,
  packetExpansionCount: 0,
  packetExpansionChars: 0,
  packetReuseCharsSaved: 0,
  followUpDeltaRatio: null,
};

export function recordPacketTelemetry(patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (key in tierCounters) tierCounters[key] = value;
  }
  return { ...tierCounters };
}

export function packetTelemetry() {
  return { ...tierCounters };
}

/**
 * Progressive disclosure: given the sections already sent and the follow-up
 * delta, return ONLY the sections that must be (re)sent. Essential sections
 * are included on first send; on expansion only genuinely missing sections
 * plus the changed ones are returned.
 */
export function expandPacketSections({ sectionsSent = [], delta = null, essential = [], firstSend = false } = {}) {
  const sent = new Set(sectionsSent);
  if (firstSend) {
    const base = [...essential];
    for (const section of Object.values(DECISION_PACKET_SECTION)) {
      if (!base.includes(section) && !sent.has(section)) {
        // First send covers essentials; non-essentials arrive via tier budget.
        break;
      }
    }
    return [...new Set([...essential])];
  }
  if (!delta || delta.changed !== true) return [];
  const out = [];
  for (const section of delta.changedSections || []) {
    if (!sent.has(section)) out.push(section);
  }
  return out;
}
