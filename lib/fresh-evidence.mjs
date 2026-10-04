// V16.4 Slice D (part 1): fresh-evidence follow-up.
//
// Split providerSeenEvidence from currentRepositoryEvidence. Before any
// follow-up the local side refreshes repository state, computes a delta, and
// sends only changed sections. knownFiles for local verification must reflect
// CURRENT state; stale state fails closed to local-only.

import { createHash } from "node:crypto";

export function fingerprintEvidence(evidence = {}) {
  const canonical = stableStringify(evidence);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function snapshotRepositoryEvidence({ files = {}, diff = "", diagnostics = [], failingTests = [] } = {}) {
  const names = Object.keys(files).sort();
  return {
    files: { ...files },
    knownFiles: names,
    diff: String(diff || ""),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.slice() : [],
    failingTests: Array.isArray(failingTests) ? failingTests.slice() : [],
    fingerprint: fingerprintEvidence({ files, diff, diagnostics, failingTests }),
  };
}

/**
 * Compute the follow-up delta between what the provider saw and current state.
 * Returns { changed, changedSections, changedFiles, priorFingerprint,
 * currentFingerprint, verificationChanged } with explicit provenance.
 */
export function computeFollowUpDelta(providerSeen = {}, current = {}) {
  const priorFingerprint = providerSeen.fingerprint || fingerprintEvidence(providerSeen);
  const currentFingerprint = current.fingerprint || fingerprintEvidence(current);
  const changedSections = [];
  const changedFiles = [];
  if (String(providerSeen.diff || "") !== String(current.diff || "")) changedSections.push("currentDiff");
  const before = providerSeen.files || {};
  const after = current.files || {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (String(before[name] ?? "") !== String(after[name] ?? "")) changedFiles.push(name);
  }
  if (changedFiles.length) changedSections.push("exactRelevantSnippets");
  if (JSON.stringify(providerSeen.diagnostics || []) !== JSON.stringify(current.diagnostics || [])) {
    changedSections.push("failingTestRuntimeEvidence");
  }
  if (JSON.stringify(providerSeen.failingTests || []) !== JSON.stringify(current.failingTests || [])) {
    if (!changedSections.includes("failingTestRuntimeEvidence")) changedSections.push("failingTestRuntimeEvidence");
  }
  const verificationChanged = changedSections.includes("failingTestRuntimeEvidence");
  return {
    changed: priorFingerprint !== currentFingerprint,
    changedSections,
    changedFiles: changedFiles.sort(),
    priorFingerprint,
    currentFingerprint,
    verificationChanged,
    provenance: "local-repository-refresh",
  };
}

/**
 * Gate a follow-up: refuse to send when the refresh failed (fail closed) or
 * when nothing changed (no redundant resend). Returns
 * { ok, reason, delta }.
 */
export function gateFollowUpDispatch(providerSeen, current, { refreshOk = true } = {}) {
  if (!refreshOk || !current) {
    return { ok: false, reason: "stale-repository-state", delta: null };
  }
  const delta = computeFollowUpDelta(providerSeen || {}, current);
  if (!delta.changed) return { ok: true, reason: "no-change", delta, sendDelta: false };
  return { ok: true, reason: "fresh-delta", delta, sendDelta: true };
}
