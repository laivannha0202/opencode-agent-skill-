import { adaptiveCompactionBudget } from "./adaptive-compaction.mjs"
import { routeToolContent } from "./content-router-v2.mjs"
import { cacheAwareVisibleBudget } from "./provider-cache-stability.mjs"
import { compactReversibleOutput } from "./performance-fabric.mjs"
import { recordEfficiencyEvent } from "./efficiency-ledger.mjs"
import { putEvidence } from "./evidence-store.mjs"
import { lineDelta, observeSeenContext } from "./seen-context-ledger.mjs"
import {
  assertNoLossyTransform,
  compressRepetitiveOutput,
  detectNoiseFamilies,
  economyCompressionAdvice,
  recordEconomyOutcome,
  resolveEconomyMode,
  shouldAutoCompress,
  toolOutputEconomyTelemetry,
} from "./tool-output-economy-v16-6.mjs"

function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

export async function governToolOutput(root, text, options = {}) {
  const originalRaw = String(text || "")
  let raw = originalRaw
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
  // ---------------------------------------------------------------------
  // V16.6.1 tool-output economy. The DEFAULT is `auto`, not `off`: reversible
  // noise compression of a large terminal transcript is a real saving and the
  // lossless audit already proves nothing signal-bearing is dropped. AUTO
  // compresses only when EVERY precondition holds and reports its refusal
  // reason when it does not; `off` and `on` stay available as operator
  // overrides, and `options.economy === true` keeps forcing compression.
  // ---------------------------------------------------------------------
  const economyMode = options.economy === true
    ? { mode: "on", source: "caller", normalized: true, raw: "true" }
    : options.economy === false
      ? { mode: "off", source: "caller", normalized: true, raw: "false" }
      : resolveEconomyMode(options.env || process.env)
  const economyRefusalReasons = []
  const gate = shouldAutoCompress({
    mode: economyMode.mode,
    phase,
    failed: options.failed === true,
    securityEvidence: options.securityEvidence === true,
    errorEvidence: options.errorEvidence === true,
    rawArchived: true,
    families: detectNoiseFamilies(raw, {}),
    learnerPressure: false,
  })
  const economyEnabled = gate.compress && raw.length >= 256
  let economy = null
  let economyRef = null
  if (!gate.compress) economyRefusalReasons.push(gate.reason)
  if (economyEnabled && phase !== "verify" && options.failed !== true && raw.length >= 256) {
    const advice = economyCompressionAdvice({ commandFamily: route.reducer, model: options.model }, {})
    const candidate = compressRepetitiveOutput(raw, { enabled: true, minRun: advice.minRun })
    const audit = assertNoLossyTransform(raw, candidate.text, { requireShorter: true })
    // The learner may RELAX compression after observed rehydration pressure.
    if (advice.action === "relax") economyRefusalReasons.push(`learner-relaxed:${advice.reason}`)
    if (!candidate.compressed) economyRefusalReasons.push("nothing-to-compress")
    if (!audit.ok) economyRefusalReasons.push("lossless-audit-failed")
    if (candidate.compressed && audit.ok) {
      const evidence = await putEvidence(root, raw, {
        kind: options.kind || ("tool-" + String(options.toolName || "output") + "-raw"),
        source: options.source || command,
        summary: "Exact raw tool output preserved before V16.6 tool-output economy compression",
      }).catch(() => null)
      if (evidence?.ref) {
        economyRef = evidence.ref
        const visible = [
          `[UES V16.6 tool-output economy: ${candidate.runsCollapsed} noise line(s) collapsed; exact raw: ${evidence.ref}]`,
          candidate.text,
        ].join("\n")
        economy = {
          ...toolOutputEconomyTelemetry(candidate, {
            rehydrations: options.rawRehydrated === true ? 1 : 0,
            missedEvidence: options.missedEvidence === true,
            compressionRefused: false,
          }),
          advice: advice.action,
          adviceReason: advice.reason,
          minRun: advice.minRun,
          evidenceRef: evidence.ref,
          commandFamily: route.reducer || null,
          mode: economyMode.mode,
          policy: "tool-output-economy-wired-v16-6",
        }
        raw = visible
        await recordEfficiencyEvent(root, {
          kind: "tool-output-economy",
          runId: options.runId || null,
          beforeChars: originalRaw.length,
          afterChars: visible.length,
          commandFamily: route.reducer,
          contentType: route.contentType,
          cacheMode,
        }).catch(() => null)
        recordEconomyOutcome({
          commandFamily: route.reducer,
          model: options.model,
          compressed: true,
          rawOutputChars: originalRaw.length,
          visibleOutputChars: visible.length,
          laterRawRehydration: options.rawRehydrated === true,
          missedEvidenceAfterCompression: options.missedEvidence === true,
        })
      }
    }
  }
  const toolName = String(options.toolName || "")
  const sessionId = String(options.sessionId || "").trim()
  const deltaEligible =
    Boolean(sessionId) &&
    phase !== "verify" &&
    options.failed !== true &&
    ["read", "grep", "find", "ls", "ues_code"].includes(toolName) &&
    raw.length >= 512
  let deltaObservation = null
  if (deltaEligible) {
    const deltaKey = [toolName, command].join("\0")
    deltaObservation = observeSeenContext(sessionId, deltaKey, raw, { maxStoredChars: 256 * 1024 })
    if (deltaObservation.state === "UNCHANGED") {
      const evidence = await putEvidence(root, raw, {
        kind: options.kind || ("tool-" + toolName + "-output"),
        source: options.source || command,
        summary: "Exact repeated tool output preserved before V16.4 same-session deduplication",
      }).catch(() => null)
      if (evidence?.ref) {
        const visible = [
          `[UES V16.4 delta context: UNCHANGED; ${raw.length} chars not resent]`,
          `contentHash: ${deltaObservation.hash}`,
          `Exact current output: ${evidence.ref}. Recover with ues_evidence_get if the unchanged bytes are needed again.`,
        ].join("\n")
        await recordEfficiencyEvent(root, {
          kind: "delta-context-output",
          runId: options.runId || null,
          beforeChars: raw.length,
          afterChars: visible.length,
          commandFamily: route.reducer,
          contentType: route.contentType,
          deltaState: "UNCHANGED",
          cacheMode,
        }).catch(() => null)
        return {
          schemaVersion: 2,
          compacted: true,
          deduplicated: true,
          deltaState: "UNCHANGED",
          deltaRatio: 0,
          text: visible,
          originalChars: originalRaw.length,
          returnedChars: visible.length,
          evidenceRef: evidence.ref,
          strategy: "same-session-unchanged-reference",
          maxChars,
          route,
          adaptive,
          cacheMode,
          economy,
        }
      }
    } else if (deltaObservation.state === "CHANGED" && deltaObservation.previousText != null) {
      const delta = lineDelta(deltaObservation.previousText, raw, { contextLines: 2, maxChars: Math.min(maxChars, 12 * 1024) })
      if (delta.changed && delta.ratio <= 0.55 && delta.text.length + 640 < raw.length) {
        const evidence = await putEvidence(root, raw, {
          kind: options.kind || ("tool-" + toolName + "-output"),
          source: options.source || command,
          summary: "Exact changed tool output preserved before V16.4 same-session delta presentation",
        }).catch(() => null)
        if (evidence?.ref) {
          const visible = [
            `[UES V16.4 delta context: CHANGED; showing bounded delta; full=${raw.length} chars]`,
            `previousHash: ${deltaObservation.previousHash}; currentHash: ${deltaObservation.hash}`,
            `Exact current output: ${evidence.ref}. Recover with ues_evidence_get when full bytes are required.`,
            "",
            delta.text,
          ].join("\n")
          await recordEfficiencyEvent(root, {
            kind: "delta-context-output",
            runId: options.runId || null,
            beforeChars: raw.length,
            afterChars: visible.length,
            commandFamily: route.reducer,
            contentType: route.contentType,
            deltaState: "CHANGED",
            deltaRatio: delta.ratio,
            cacheMode,
          }).catch(() => null)
          return {
            schemaVersion: 2,
            compacted: true,
            deduplicated: false,
            deltaState: "CHANGED",
            deltaRatio: delta.ratio,
            text: visible,
            originalChars: originalRaw.length,
            returnedChars: visible.length,
            evidenceRef: evidence.ref,
            strategy: "same-session-line-delta",
            maxChars,
            route,
            adaptive,
            cacheMode,
            economy,
          }
        }
      }
    }
  }
  if (!raw || raw.length <= maxChars) {
    return {
      schemaVersion: 2,
      compacted: economy ? true : false,
      text: raw,
      originalChars: originalRaw.length,
      returnedChars: raw.length,
      evidenceRef: economyRef,
      strategy: economy ? "tool-output-economy" : undefined,
      maxChars,
      route,
      adaptive,
      cacheMode,
      // V16.6.1: when the economy did not run, the reason is reported. A silent
      // no-op is indistinguishable from a bug.
      economyRefusal: economy ? null : [...new Set(economyRefusalReasons)],
      economyMode: economyMode.mode,
      deltaState: deltaObservation?.state || null,
      economy,
    }
  }
  const compacted = await compactReversibleOutput(root, raw, {
    maxChars,
    command,
    kind: options.kind || ("tool-" + String(options.toolName || "output")),
    source: options.source || command,
    summary: options.summary || "Raw tool output preserved by V15.9 Universal Tool Output Governor",
  })
  if (!compacted?.compacted) {
    return {
      schemaVersion: 2,
      compacted: economy ? true : false,
      text: raw,
      originalChars: originalRaw.length,
      returnedChars: raw.length,
      evidenceRef: economyRef,
      strategy: economy ? "tool-output-economy" : undefined,
      maxChars,
      route,
      adaptive,
      cacheMode,
      economy,
    }
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
    schemaVersion: 2,
    compacted: true,
    text: compacted.text,
    originalChars: originalRaw.length,
    returnedChars: compacted.returnedChars,
    evidenceRef: compacted.evidenceRef,
    strategy: compacted.strategy,
    maxChars,
    route,
    adaptive,
    cacheMode,
    deltaState: deltaObservation?.state || null,
    economy,
  }
}
