import { createHash, randomUUID } from "node:crypto"

function iso(value, field) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw new Error(field + " must be an ISO-compatible timestamp")
  return date.toISOString()
}

export function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

export function buildVerificationReceipt(input = {}) {
  const command = String(input.command || "").trim()
  if (!command) throw new Error("verification receipt command is required")
  const exitCode = Number(input.exitCode)
  if (!Number.isInteger(exitCode)) throw new Error("verification receipt exitCode must be an integer")

  const startedAt = iso(input.startedAt, "startedAt")
  const finishedAt = iso(input.finishedAt, "finishedAt")
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("verification receipt finishedAt cannot be earlier than startedAt")
  }

  const stdoutHash = input.stdoutHash || hashText(input.stdout)
  const stderrHash = input.stderrHash || hashText(input.stderr)
  for (const [field, value] of [["stdoutHash", stdoutHash], ["stderrHash", stderrHash]]) {
    if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) throw new Error(field + " must be a sha256 hex digest")
  }

  return {
    schemaVersion: 1,
    id: String(input.id || randomUUID()),
    scope: String(input.scope || "task"),
    command,
    exitCode,
    passed: exitCode === 0,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    stdoutHash,
    stderrHash,
    workspaceFingerprint: input.workspaceFingerprint ? String(input.workspaceFingerprint) : null,
    executorSessionID: input.executorSessionID ? String(input.executorSessionID) : null,
    runId: input.runId ? String(input.runId) : null,
    timedOut: Boolean(input.timedOut),
    idleTimedOut: Boolean(input.idleTimedOut),
    cancelled: Boolean(input.cancelled),
  }
}

export function validateVerificationReceipt(receipt) {
  try {
    const normalized = buildVerificationReceipt(receipt)
    return { valid: true, receipt: normalized, errors: [] }
  } catch (error) {
    return { valid: false, receipt: null, errors: [String(error?.message || error)] }
  }
}
