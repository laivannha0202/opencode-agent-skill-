import { createHash, randomUUID } from "node:crypto"

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

export function createVerificationReceipt(input = {}) {
  const command = String(input.command || "").trim()
  if (!command) throw new Error("verification receipt command is required")

  const exitCode = Number(input.exitCode)
  if (!Number.isInteger(exitCode)) throw new Error("verification receipt exitCode must be an integer")

  const startedAt = String(input.startedAt || new Date().toISOString())
  const finishedAt = String(input.finishedAt || new Date().toISOString())

  return {
    schemaVersion: 1,
    id: input.id || randomUUID(),
    task: input.task || null,
    runId: input.runId || null,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    cwd: input.cwd || null,
    exitCode,
    passed: exitCode === 0,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    stdoutSha256: digest(input.stdout),
    stderrSha256: digest(input.stderr),
    workspaceBefore: input.workspaceBefore || null,
    workspaceAfter: input.workspaceAfter || null,
  }
}

export function validateVerificationReceipt(receipt) {
  const errors = []
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["receipt must be an object"] }
  }
  if (receipt.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (!String(receipt.id || "").trim()) errors.push("id is required")
  if (!String(receipt.command || "").trim()) errors.push("command is required")
  if (!Number.isInteger(receipt.exitCode)) errors.push("exitCode must be an integer")
  if (typeof receipt.passed !== "boolean") errors.push("passed must be boolean")
  if (!String(receipt.stdoutSha256 || "").match(/^[a-f0-9]{64}$/)) errors.push("stdoutSha256 is invalid")
  if (!String(receipt.stderrSha256 || "").match(/^[a-f0-9]{64}$/)) errors.push("stderrSha256 is invalid")
  return { valid: errors.length === 0, errors }
}
