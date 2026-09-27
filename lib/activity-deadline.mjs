function finite(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function createAdaptiveDeadline(options = {}, startedAt = Date.now()) {
  const initialMs = finite(options.hardTimeoutMs, 60_000, 1_000)
  const absoluteMs = Math.max(
    initialMs,
    finite(options.absoluteHardTimeoutMs, initialMs, initialMs),
  )
  const extensionMs = finite(options.activityExtensionMs, 0, 0, absoluteMs)
  const activityWindowMs = finite(
    options.activityWindowMs,
    Math.max(5_000, Math.min(extensionMs || initialMs, 30_000)),
    1_000,
    absoluteMs,
  )

  let deadlineAt = startedAt + initialMs
  const absoluteAt = startedAt + absoluteMs
  let extensions = 0

  function maybeExtend(now = Date.now(), lastActivityAt = 0) {
    if (extensionMs <= 0 || deadlineAt >= absoluteAt) {
      return { extended: false, deadlineAt, absoluteAt, extensions }
    }
    if (now - Number(lastActivityAt || 0) > activityWindowMs) {
      return { extended: false, deadlineAt, absoluteAt, extensions }
    }
    const next = Math.min(absoluteAt, Math.max(deadlineAt, now + extensionMs))
    if (next <= deadlineAt) {
      return { extended: false, deadlineAt, absoluteAt, extensions }
    }
    deadlineAt = next
    extensions += 1
    return { extended: true, deadlineAt, absoluteAt, extensions }
  }

  function shouldAbort(now = Date.now(), lastActivityAt = 0) {
    if (now < deadlineAt) {
      return { abort: false, deadlineAt, absoluteAt, extensions }
    }
    const extension = maybeExtend(now, lastActivityAt)
    if (extension.extended) {
      return { abort: false, ...extension }
    }
    return {
      abort: true,
      reason: now >= absoluteAt ? "absolute-hard-timeout" : "hard-timeout",
      deadlineAt,
      absoluteAt,
      extensions,
    }
  }

  return {
    startedAt,
    initialMs,
    absoluteMs,
    extensionMs,
    activityWindowMs,
    get deadlineAt() { return deadlineAt },
    get absoluteAt() { return absoluteAt },
    get extensions() { return extensions },
    maybeExtend,
    shouldAbort,
  }
}
