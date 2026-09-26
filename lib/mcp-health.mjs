const TRANSIENT_ERROR =
  /(timeout|timed out|econnreset|econnrefused|socket|connection (?:closed|reset|lost)|transport|network|temporar(?:y|ily)|service unavailable|bad gateway|gateway timeout|\b502\b|\b503\b|\b504\b|rate limit|\b429\b)/i

function nowMs(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : Date.now()
}

export function isTransientMcpFailure(value = "") {
  return TRANSIENT_ERROR.test(String(value || ""))
}

export function mcpReconnectAdvice(input = {}) {
  const policy = input.policy || {}
  const attempt = Math.max(1, Math.trunc(Number(input.attempt || 1)))
  const transient = isTransientMcpFailure(input.error || input.message || "")
  const destructive = policy.confirmationRequired === true || policy.annotations?.destructiveHint === true
  const retryable = policy.retryAllowed === true && transient && !destructive && attempt < Math.max(1, Number(input.maxAttempts || 3))
  return {
    schemaVersion: 1,
    retryable,
    reconnectRecommended: retryable,
    reason: destructive
      ? "destructive-tool-never-auto-reconnect"
      : !transient
        ? "non-transient-failure"
        : policy.retryAllowed !== true
          ? "tool-not-explicitly-idempotent"
          : retryable
            ? "transient-idempotent-failure"
            : "retry-budget-exhausted",
    backoffMs: retryable ? Math.min(5_000, 250 * (2 ** Math.max(0, attempt - 1))) : 0,
  }
}

export class McpHealthTracker {
  constructor(options = {}) {
    this.failureThreshold = Math.max(1, Math.min(10, Number(options.failureThreshold || 2)))
    this.cooldownMs = Math.max(1_000, Math.min(5 * 60_000, Number(options.cooldownMs || 15_000)))
    this.maxEntries = Math.max(16, Math.min(2_000, Number(options.maxEntries || 256)))
    this.state = new Map()
    this.active = new Map()
  }

  clear() {
    this.state.clear()
    this.active.clear()
  }

  begin(callId, toolName, policy = {}, at = Date.now()) {
    const id = String(callId || "")
    const name = String(toolName || "")
    if (id && name) this.active.set(id, { name, policy, startedAt: nowMs(at) })
    this.#trim()
    return this.status(name, at)
  }

  finish(callId, result = {}, at = Date.now()) {
    const id = String(callId || "")
    const active = this.active.get(id)
    if (!active) return null
    this.active.delete(id)
    const timestamp = nowMs(at)
    const previous = this.state.get(active.name) || {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastError: null,
      lastFinishedAt: 0,
    }
    const errorText = [
      result.error,
      result.message,
      result.stderr,
      result.text,
    ].filter(Boolean).join("\n").slice(0, 4000)
    const failed = result.isError === true || Number(result.exitCode) > 0
    const transient = failed && isTransientMcpFailure(errorText)
    const consecutiveFailures = failed ? Number(previous.consecutiveFailures || 0) + 1 : 0
    const cooldownUntil = transient && consecutiveFailures >= this.failureThreshold
      ? timestamp + this.cooldownMs
      : failed
        ? Number(previous.cooldownUntil || 0)
        : 0
    const next = {
      successes: Number(previous.successes || 0) + (failed ? 0 : 1),
      failures: Number(previous.failures || 0) + (failed ? 1 : 0),
      consecutiveFailures,
      cooldownUntil,
      lastError: failed ? errorText || "tool-result-error" : null,
      lastTransientFailure: transient,
      lastFinishedAt: timestamp,
      policy: active.policy,
    }
    this.state.set(active.name, next)
    this.#trim()
    return this.status(active.name, timestamp)
  }

  status(toolName, at = Date.now()) {
    const name = String(toolName || "")
    const row = this.state.get(name)
    const timestamp = nowMs(at)
    if (!row) {
      return { schemaVersion: 1, tool: name, status: "unknown", available: true, consecutiveFailures: 0, cooldownUntil: null }
    }
    const coolingDown = Number(row.cooldownUntil || 0) > timestamp
    return {
      schemaVersion: 1,
      tool: name,
      status: coolingDown ? "degraded" : row.consecutiveFailures > 0 ? "recovering" : "healthy",
      available: !coolingDown,
      successes: row.successes,
      failures: row.failures,
      consecutiveFailures: row.consecutiveFailures,
      cooldownUntil: coolingDown ? new Date(row.cooldownUntil).toISOString() : null,
      lastError: row.lastError,
      lastTransientFailure: row.lastTransientFailure === true,
      lastFinishedAt: row.lastFinishedAt ? new Date(row.lastFinishedAt).toISOString() : null,
    }
  }

  available(toolName, at = Date.now()) {
    return this.status(toolName, at).available !== false
  }

  snapshot(at = Date.now()) {
    return [...this.state.keys()]
      .sort()
      .map((name) => this.status(name, at))
  }

  #trim() {
    if (this.state.size <= this.maxEntries) return
    const ordered = [...this.state.entries()].sort((a, b) => Number(a[1]?.lastFinishedAt || 0) - Number(b[1]?.lastFinishedAt || 0))
    for (const [name] of ordered.slice(0, Math.max(0, this.state.size - this.maxEntries))) this.state.delete(name)
  }
}
