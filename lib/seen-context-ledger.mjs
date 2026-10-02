import { createHash } from "node:crypto"

const SCOPES = new Map()
const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_TTL_MS = 30 * 60_000

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

function scopeMap(scope) {
  const key = String(scope || "default")
  let map = SCOPES.get(key)
  if (!map) {
    map = new Map()
    SCOPES.set(key, map)
  }
  return map
}

function prune(map, now, ttlMs, maxEntries) {
  for (const [key, row] of map) {
    if (now - Number(row.at || 0) > ttlMs) map.delete(key)
  }
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest == null) break
    map.delete(oldest)
  }
}

export function observeSeenContext(scope, key, text, options = {}) {
  const now = Date.now()
  const ttlMs = Math.max(1000, Math.min(24 * 60 * 60_000, Number(options.ttlMs || DEFAULT_TTL_MS)))
  const maxEntries = Math.max(16, Math.min(4096, Math.trunc(Number(options.maxEntries || DEFAULT_MAX_ENTRIES))))
  const map = scopeMap(scope)
  prune(map, now, ttlMs, maxEntries)
  const id = String(key || "context")
  const value = String(text || "")
  const currentHash = digest(value)
  const previous = map.get(id) || null
  const pinned = options.pinned === true
  let state = "NEW"
  if (pinned) state = "PINNED"
  else if (previous && previous.hash === currentHash) state = "UNCHANGED"
  else if (previous) state = "CHANGED"
  map.delete(id)
  map.set(id, {
    hash: currentHash,
    text: value.slice(0, Math.max(4096, Math.min(512 * 1024, Number(options.maxStoredChars || 256 * 1024)))),
    originalChars: value.length,
    at: now,
    pinned,
  })
  prune(map, now, ttlMs, maxEntries)
  return {
    schemaVersion: 1,
    scope: String(scope || "default"),
    key: id,
    state,
    hash: currentHash,
    chars: value.length,
    previousHash: previous?.hash || null,
    previousChars: previous?.originalChars ?? null,
    previousText: previous?.text ?? null,
    restorable: Boolean(previous || value),
  }
}

export function lineDelta(previousText, currentText, options = {}) {
  const before = String(previousText || "").split(/\r?\n/)
  const after = String(currentText || "").split(/\r?\n/)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1
  if (prefix === before.length && prefix === after.length) {
    return { changed: false, text: "", changedLines: 0, totalLines: after.length, ratio: 0 }
  }
  const contextLines = Math.max(0, Math.min(12, Math.trunc(Number(options.contextLines ?? 2))))
  const start = Math.max(0, prefix - contextLines)
  const endExclusive = Math.min(after.length, after.length - suffix + contextLines)
  const slice = after.slice(start, endExclusive)
  const changedLines = Math.max(1, (after.length - suffix) - prefix)
  const ratio = after.length ? slice.length / after.length : 1
  const maxChars = Math.max(512, Math.min(64 * 1024, Number(options.maxChars || 12 * 1024)))
  const rendered = [
    `@@ current lines ${start + 1}-${endExclusive}/${after.length}; previous lines=${before.length} @@`,
    ...slice.map((line, index) => `${String(start + index + 1).padStart(5, " ")} | ${line}`),
  ].join("\n")
  return {
    changed: true,
    text: rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars) + "\n...[delta truncated]",
    changedLines,
    totalLines: after.length,
    ratio,
    startLine: start + 1,
    endLine: endExclusive,
  }
}

export function resetSeenContextLedger(scope) {
  if (scope == null) SCOPES.clear()
  else SCOPES.delete(String(scope))
}

export function seenContextLedgerStats(scope) {
  if (scope != null) return { schemaVersion: 1, scope: String(scope), entries: scopeMap(scope).size }
  return {
    schemaVersion: 1,
    scopes: SCOPES.size,
    entries: [...SCOPES.values()].reduce((sum, map) => sum + map.size, 0),
  }
}
