import { createHash } from "node:crypto"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
  return out
}

function sha256(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(canonical(value)),
  ).digest("hex")
}

function sortedStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort()
}

export function runtimeSurfaceHash(values = []) {
  return "sha256:" + sha256(sortedStrings(values))
}

export function buildRuntimeEpoch(input = {}) {
  const tools = sortedStrings(input.tools)
  const skills = sortedStrings(input.skills)
  const modelProfile = input.modelProfile && typeof input.modelProfile === "object"
    ? canonical(input.modelProfile)
    : null
  const cachePolicy = input.cachePolicy && typeof input.cachePolicy === "object"
    ? canonical({
        schemaVersion: input.cachePolicy.schemaVersion ?? 1,
        mode: input.cachePolicy.mode ?? "neutral",
        preserveStablePrefix: input.cachePolicy.preserveStablePrefix !== false,
        compactLiveZoneOnly: input.cachePolicy.compactLiveZoneOnly !== false,
        usageAccounting: input.cachePolicy.usageAccounting ?? "pi-normalized-disjoint",
      })
    : null
  const payload = {
    schemaVersion: 1,
    policySnapshotId: input.policySnapshotId ? String(input.policySnapshotId) : null,
    workspaceFingerprint: input.workspaceFingerprint ? String(input.workspaceFingerprint) : null,
    contextSnapshotId: input.contextSnapshotId
      ? String(input.contextSnapshotId)
      : "context:sha256:" + sha256(input.context || ""),
    toolSurfaceHash: runtimeSurfaceHash(tools),
    skillSurfaceHash: runtimeSurfaceHash(skills),
    modelProfileHash: modelProfile ? "sha256:" + sha256(modelProfile) : null,
    cachePolicyHash: cachePolicy ? "sha256:" + sha256(cachePolicy) : null,
    // V16.17 (§7): the agent's PRIVILEGED system prompt is part of the runtime
    // surface. Before this, a prompt change (e.g. tightening the verifier's PASS
    // rules) did NOT change the epoch, so a warm RPC worker launched with the old
    // prompt could keep serving privileged work. Binding the prompt hash into the
    // epoch makes every warm worker key and every cached artifact invalidate the
    // instant the privileged context changes.
    systemPromptHash: input.systemPrompt ? "sha256:" + sha256(String(input.systemPrompt)) : null,
    model: input.model ? String(input.model) : null,
    thinking: input.thinking ? String(input.thinking) : null,
  }
  return Object.freeze({
    ...payload,
    id: "epoch:sha256:" + sha256(payload),
  })
}

export function runtimeEpochCompatibility(left = {}, right = {}) {
  const reasons = []
  for (const key of [
    "policySnapshotId",
    "workspaceFingerprint",
    "contextSnapshotId",
    "toolSurfaceHash",
    "skillSurfaceHash",
    "modelProfileHash",
    "cachePolicyHash",
    "systemPromptHash",
    "model",
    "thinking",
  ]) {
    const a = left?.[key] ?? null
    const b = right?.[key] ?? null
    if (a !== b) reasons.push(key + "-changed")
  }
  return {
    compatible: reasons.length === 0,
    exactIdMatch: Boolean(left?.id && right?.id && left.id === right.id),
    reasons,
  }
}
