import { adaptiveCompactionBudget } from "./adaptive-compaction.mjs"
import { routeToolContent } from "./content-router-v2.mjs"
import { cacheAwareVisibleBudget } from "./provider-cache-stability.mjs"
import { compactReversibleOutput } from "./performance-fabric.mjs"
import { recordEfficiencyEvent } from "./efficiency-ledger.mjs"

function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

export async function governToolOutput(root, text, options = {}) {
  const raw = String(text || "")
  const baseMaxChars = bounded(options.baseMaxChars, 24 * 1024, 4 * 1024, 256 * 1024)
  const command = String(options.command || options.toolName || "tool")
  const phase = String(options.phase || "execute")
  const route = routeToolContent(raw, { command, phase, kind: options.kind || ("tool-" + String(options.toolName || "output")) })
  const adaptive = await adaptiveCompactionBudget(root, command, baseMaxChars).catch(() => ({
    schemaVersion: 1, family: null, samples: 0, recallRate: null,
    baseMaxChars, maxChars: baseMaxChars, multiplier: 1, reason: "adaptive-budget-unavailable",
  }))
  const cacheMode = String(options.cacheMode || "neutral")
  const maxChars = cacheAwareVisibleBudget(Number(adaptive.maxChars || baseMaxChars), route, { mode: cacheMode })
  if (!raw || raw.length <= maxChars) {
    return { schemaVersion: 1, compacted: false, text: raw, originalChars: raw.length, returnedChars: raw.length, maxChars, route, adaptive, cacheMode }
  }
  const compacted = await compactReversibleOutput(root, raw, {
    maxChars,
    command,
    kind: options.kind || ("tool-" + String(options.toolName || "output")),
    source: options.source || command,
    summary: options.summary || "Raw tool output preserved by V15.9 Universal Tool Output Governor",
  })
  if (!compacted?.compacted) {
    return { schemaVersion: 1, compacted: false, text: raw, originalChars: raw.length, returnedChars: raw.length, maxChars, route, adaptive, cacheMode }
  }
  await recordEfficiencyEvent(root, {
    kind: "tool-output-governor",
    runId: options.runId || null,
    beforeChars: compacted.originalChars,
    afterChars: compacted.returnedChars,
    commandFamily: compacted.commandFamily || route.reducer,
    contentType: route.contentType,
    cacheMode,
  }).catch(() => null)
  return {
    schemaVersion: 1,
    compacted: true,
    text: compacted.text,
    originalChars: compacted.originalChars,
    returnedChars: compacted.returnedChars,
    evidenceRef: compacted.evidenceRef,
    strategy: compacted.strategy,
    maxChars,
    route,
    adaptive,
    cacheMode,
  }
}
