import { createHash } from "node:crypto"

const EXPLORATION_TOOL = /(?:^|[._-])(read|grep|glob|repo[-_.]?graph|semantic[-_.]?search|aci[-_.]?search)(?:$|[._-])/i
const VERIFY_OR_WRITE_TOOL = /(?:^|[._-])(edit|write|patch|bash|shell|verify|test|apply)(?:$|[._-])/i

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  )
}

export function stableRuntimeHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(canonical(value))
  return createHash("sha256").update(text || "").digest("hex")
}

export function isExplorationTool(tool) {
  return EXPLORATION_TOOL.test(String(tool || ""))
}

export function budgetToolResult(tool, result, options = {}) {
  const name = String(tool || "")
  const aggressive = /grep|glob|repo[-_.]?graph|semantic[-_.]?search/i.test(name)
  const maxChars = Math.max(2_000, Number(options.maxChars || (aggressive ? 12_000 : 24_000)))
  const maxLines = Math.max(40, Number(options.maxLines || (aggressive ? 160 : 360)))

  if (!aggressive && !/read/i.test(name)) return result

  const original = typeof result === "string" ? result : String(result?.output || "")
  const lines = original.split(/\r?\n/)
  if (original.length <= maxChars && lines.length <= maxLines) return result

  const digest = stableRuntimeHash(original)
  const headLineCount = Math.max(1, Math.floor(maxLines * 0.7))
  const tailLineCount = Math.max(1, maxLines - headLineCount)
  let bounded = [
    ...lines.slice(0, headLineCount),
    `...[UES tool output truncated: ${lines.length} lines / ${original.length} chars, sha256=${digest.slice(0, 16)}]...`,
    ...lines.slice(-tailLineCount),
  ].join("\n")

  if (bounded.length > maxChars) {
    const marker = `\n...[UES char budget applied; sha256=${digest.slice(0, 16)}]...\n`
    const room = Math.max(0, maxChars - marker.length)
    const head = Math.floor(room * 0.7)
    bounded = bounded.slice(0, head) + marker + bounded.slice(-(room - head))
  }

  if (typeof result === "string") return bounded
  return {
    ...result,
    output: bounded,
    metadata: {
      ...(result?.metadata || {}),
      uesTruncated: true,
      uesOriginalChars: original.length,
      uesOriginalLines: lines.length,
      uesOutputDigest: digest,
    },
  }
}

export function classifyProviderFailure(error = {}) {
  const status = Number(error?.status ?? error?.cause?.status)
  const type = String(error?.type || error?.code || "")
  const message = String(error?.message || error || "")
  const value = `${type} ${message}`.toLowerCase()

  if (status === 401 || status === 403 || /auth|unauthori[sz]ed|invalid api key|credential/.test(value)) return "AUTH"
  if (/context.{0,20}(large|length|window|overflow)|too many tokens|max(?:imum)? context/.test(value)) return "CONTEXT_TOO_LARGE"
  if (status === 429 || /rate.?limit|too many requests/.test(value)) return "RATE_LIMIT"
  if (/quota|credit|billing|insufficient balance/.test(value)) return "QUOTA"
  if (/no token|no output|empty response|empty completion|returned no content|no content|stalled|no-progress/.test(value)) return "NO_TOKEN"
  if (/timeout|timed out|deadline|abort(?:ed)?/.test(value)) return "TIMEOUT"
  if (Number.isFinite(status) && status >= 500 && status < 600) return "PROVIDER_5XX"
  if (/provider|upstream|gateway|service unavailable/.test(value)) return "PROVIDER_5XX"
  return "OTHER"
}

export function progressWatchdogDecision(snapshot = {}, now = Date.now(), stallMs = 60_000) {
  const limit = Math.max(30_000, Math.min(Number(stallMs || 60_000), 5 * 60_000))
  const lastProgressAt = Number(snapshot.lastProgressAt || 0)
  const activeToolCalls = Math.max(0, Number(snapshot.activeToolCalls || 0))
  const idleMs = Math.max(0, Number(now) - lastProgressAt)

  if (activeToolCalls > 0) {
    return { stalled: false, idleMs, limitMs: limit, reason: "tool-active" }
  }
  return {
    stalled: idleMs >= limit,
    idleMs,
    limitMs: limit,
    reason: idleMs >= limit ? "no-progress" : "within-grace",
  }
}

export function providerRecoveryPlan(kind, physicalAttempt = 1, options = {}) {
  const attempt = Math.max(1, Number(physicalAttempt || 1))
  const hasEscalationModel = Boolean(options.hasEscalationModel)

  if (kind === "AUTH") return { action: "fail-fast", retry: false, reason: "authentication failure requires user/config repair" }
  if (kind === "CONTEXT_TOO_LARGE") return { action: "compact-context", retry: false, reason: "reduce/compact context instead of repeating the same request" }
  if (kind === "QUOTA") {
    return hasEscalationModel
      ? { action: "fresh-session-escalated-model", retry: true, reason: "quota exhausted on current provider/model" }
      : { action: "fail-retryable", retry: false, reason: "quota exhausted and no configured fallback model exists" }
  }

  if (["NO_TOKEN", "TIMEOUT", "RATE_LIMIT", "PROVIDER_5XX"].includes(kind)) {
    if (attempt <= 1) {
      return { action: "fresh-session-same-model", retry: true, reason: "retry transport/provider stall once with fresh session state" }
    }
    if (hasEscalationModel) {
      return { action: "fresh-session-escalated-model", retry: true, reason: "repeated provider failure triggers configured model/provider escalation" }
    }
    return { action: "fail-retryable", retry: false, reason: "repeated provider failure without configured fallback" }
  }

  return { action: "fail-task", retry: false, reason: "non-provider failure should be diagnosed by the task recovery policy" }
}

function createSessionState(now = Date.now()) {
  return {
    signatures: new Map(),
    lastWorkspaceSignal: null,
    lastEvidenceKey: null,
    noProgressCalls: 0,
    loopBlocked: false,
    lastProgressAt: now,
    activeCalls: new Set(),
    compactionAt: null,
  }
}

export function createRuntimeGuard(options = {}) {
  const duplicateLimit = Math.max(2, Number(options.duplicateLimit || 3))
  const loopLimit = Math.max(4, Number(options.loopLimit || 6))
  const sessions = new Map()

  function stateFor(sessionID, at = Date.now()) {
    const key = String(sessionID || "global")
    if (!sessions.has(key)) sessions.set(key, createSessionState(at))
    return sessions.get(key)
  }

  function resetForWorkspace(state, workspaceSignal) {
    if (state.lastWorkspaceSignal === null || state.lastWorkspaceSignal === workspaceSignal) return
    state.signatures.clear()
    state.noProgressCalls = 0
    state.loopBlocked = false
    state.lastEvidenceKey = null
  }

  return {
    before(input = {}) {
      const at = Number(input.now || Date.now())
      const state = stateFor(input.sessionID, at)
      const workspaceSignal = String(input.workspaceSignal || "")
      resetForWorkspace(state, workspaceSignal)
      state.lastWorkspaceSignal = workspaceSignal

      const tool = String(input.tool || "")
      if (isExplorationTool(tool)) {
        const signature = stableRuntimeHash({ tool, input: input.input || {}, cwd: input.cwd || "", workspaceSignal })
        const seen = state.signatures.get(signature) || { count: 0, lastResultHash: null }
        seen.count += 1
        state.signatures.set(signature, seen)

        if (state.loopBlocked) {
          return {
            blocked: true,
            code: "UES_LOOP_DETECTED",
            message: `UES loop guard blocked repeated exploration after ${state.noProgressCalls} no-progress calls. Choose a deterministic next action: edit the scoped target, run focused verification, inspect a direct caller/failing stack, change hypothesis, or escalate recovery.`,
            signature,
          }
        }
        if (seen.count > duplicateLimit) {
          return {
            blocked: true,
            code: "UES_DUPLICATE_TOOL",
            message: `UES duplicate-tool guard blocked ${tool}: equivalent arguments were already executed ${seen.count - 1} times with no workspace change. Use the previous evidence or change the query/scope before retrying.`,
            signature,
          }
        }
      }

      state.lastProgressAt = at
      if (input.callID) state.activeCalls.add(String(input.callID))
      return { blocked: false }
    },

    after(input = {}) {
      const at = Number(input.now || Date.now())
      const state = stateFor(input.sessionID, at)
      const workspaceSignal = String(input.workspaceSignal || "")
      const tool = String(input.tool || "")
      if (input.callID) state.activeCalls.delete(String(input.callID))
      resetForWorkspace(state, workspaceSignal)

      if (input.status === "completed" && isExplorationTool(tool)) {
        const resultHash = stableRuntimeHash(input.result || "")
        const evidenceKey = stableRuntimeHash({ workspaceSignal, resultHash })
        if (state.lastEvidenceKey === evidenceKey) {
          state.noProgressCalls += 1
        } else {
          state.lastEvidenceKey = evidenceKey
          state.noProgressCalls = 0
        }
        if (state.noProgressCalls >= loopLimit) state.loopBlocked = true

        const signature = stableRuntimeHash({ tool, input: input.input || {}, cwd: input.cwd || "", workspaceSignal })
        const seen = state.signatures.get(signature)
        if (seen) seen.lastResultHash = resultHash
      } else if (
        input.status === "completed" &&
        (VERIFY_OR_WRITE_TOOL.test(tool) || state.lastWorkspaceSignal !== workspaceSignal)
      ) {
        state.noProgressCalls = 0
        state.loopBlocked = false
        state.lastEvidenceKey = null
        state.signatures.clear()
      }

      state.lastWorkspaceSignal = workspaceSignal
      state.lastProgressAt = at
      return {
        loopBlocked: state.loopBlocked,
        noProgressCalls: state.noProgressCalls,
        lastProgressAt: state.lastProgressAt,
      }
    },

    touch(sessionID, at = Date.now()) {
      const state = stateFor(sessionID, at)
      state.lastProgressAt = Number(at)
    },

    compacted(sessionID, at = Date.now()) {
      const state = stateFor(sessionID, at)
      state.compactionAt = Number(at)
      state.lastProgressAt = Number(at)
      state.signatures.clear()
      state.noProgressCalls = 0
      state.loopBlocked = false
      state.lastEvidenceKey = null
    },

    snapshot(sessionID) {
      const state = stateFor(sessionID)
      return {
        noProgressCalls: state.noProgressCalls,
        loopBlocked: state.loopBlocked,
        lastProgressAt: state.lastProgressAt,
        activeToolCalls: state.activeCalls.size,
        compactionAt: state.compactionAt,
      }
    },

    clear(sessionID) {
      sessions.delete(String(sessionID || "global"))
    },
  }
}
