import { createHash } from "node:crypto"
import path from "node:path"
import { toolConcurrencySnapshot } from "./tool-concurrency.mjs"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
  return out
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

export function buildPolicySnapshot(input = {}) {
  const tools = [...new Set((input.tools || []).map((value) => String(value || "").trim()).filter(Boolean))].sort()
  const payload = {
    schemaVersion: 1,
    agent: String(input.agent || ""),
    workspaceRoot: path.resolve(String(input.workspaceRoot || process.cwd())),
    tools,
    toolConcurrency: toolConcurrencySnapshot(tools),
    restrictions: {
      allowLocalEnvWrite: input.allowLocalEnvWrite === true,
      destructiveActions: input.destructiveActions === true ? "allowed" : "guarded",
      workspaceContainment: input.workspaceContainment !== false,
      verificationTimeoutSec: Number.isFinite(Number(input.verificationTimeoutSec))
        ? Math.max(1, Math.trunc(Number(input.verificationTimeoutSec)))
        : null,
    },
  }
  const id = "policy:sha256:" + sha256(payload)
  return Object.freeze({ ...payload, id })
}

export function childPolicyMayLoosen(parent = {}, child = {}) {
  const reasons = []
  if (parent?.restrictions?.allowLocalEnvWrite !== true && child?.restrictions?.allowLocalEnvWrite === true) reasons.push("local-env-write-loosened")
  if (parent?.restrictions?.workspaceContainment !== false && child?.restrictions?.workspaceContainment === false) reasons.push("workspace-containment-loosened")
  if (parent?.restrictions?.destructiveActions !== "allowed" && child?.restrictions?.destructiveActions === "allowed") reasons.push("destructive-policy-loosened")
  const parentTools = new Set(parent?.tools || [])
  const extraTools = (child?.tools || []).filter((tool) => !parentTools.has(tool))
  if (extraTools.length) reasons.push("child-tool-superset:" + extraTools.join(","))
  return { safe: reasons.length === 0, reasons }
}
