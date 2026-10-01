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
