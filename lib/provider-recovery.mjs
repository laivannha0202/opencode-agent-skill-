const EMPTY_PROVIDER_SIGNAL = /(?:provider\s+returned\s+an?\s+empty\s+response|empty\s+provider\s+response|empty\s+response\s*\(no\s+content\s+emitted\)|no\s+content\s+emitted)/i

function finiteInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function classifyProviderFailure(result = {}) {
  const output = String(result.output || "").trim()
  const diagnostics = [result.errorMessage, result.stderr]
    .filter(Boolean)
    .map(String)
    .join("\n")
  const toolCalls = Math.max(0, Number(result.toolCalls || 0))
  const explicitEmpty = EMPTY_PROVIDER_SIGNAL.test(diagnostics)
  const missingAssistant =
    result.noAssistantMessage === true ||
    /^\(no assistant output\)$/i.test(output) ||
    /^\(no output\)$/i.test(output)
  const transient =
    explicitEmpty ||
    missingAssistant ||
    result.providerFailure === "empty-provider-response"
  const reason = transient
    ? explicitEmpty || result.providerFailure === "empty-provider-response"
      ? "empty-provider-response"
      : "missing-assistant-output"
    : null

  return {
    transient,
    reason,
    safeReplay: transient && toolCalls === 0,
    safeSessionResume: transient && toolCalls > 0,
    toolCalls,
    stopReason: String(result.stopReason || ""),
    message: transient
      ? toolCalls === 0
        ? "Provider produced no usable assistant content before any tool side effect; a bounded fresh-session retry is safe."
        : "Provider produced no usable assistant content after tool execution; blind replay is blocked, but the same live RPC session may continue without repeating completed side effects."
      : null,
  }
}

export function providerRecoveryBackoffMs(retryNumber, options = {}) {
  const attempt = finiteInt(retryNumber, 1, 1, 8)
  const baseMs = finiteInt(options.baseMs, 250, 0, 10_000)
  const maxMs = finiteInt(options.maxMs, 2_000, baseMs, 30_000)
  return Math.min(maxMs, baseMs * (2 ** (attempt - 1)))
}
