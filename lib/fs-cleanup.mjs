import { rm } from "node:fs/promises"

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"])

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function safeRemovePath(target, options = {}) {
  const recursive = options.recursive !== false
  const force = options.force !== false
  const retries = boundedInt(options.retries, process.platform === "win32" ? 5 : 3, 0, 10)
  const retryDelayMs = boundedInt(options.retryDelayMs, 75, 10, 2_000)
  const rmImpl = typeof options.rmImpl === "function" ? options.rmImpl : rm
  let attempt = 0
  let lastError = null

  while (attempt <= retries) {
    try {
      await rmImpl(target, {
        recursive,
        force,
        ...(recursive ? { maxRetries: 2, retryDelay: retryDelayMs } : {}),
      })
      return { removed: true, attempts: attempt + 1, lastError: null }
    } catch (error) {
      lastError = error
      const code = String(error?.code || "")
      if (!RETRYABLE_REMOVE_CODES.has(code) || attempt >= retries) throw error
      await sleep(retryDelayMs * (2 ** attempt))
      attempt += 1
    }
  }

  throw lastError || new Error("safeRemovePath failed")
}
