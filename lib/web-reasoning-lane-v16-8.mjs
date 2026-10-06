// V16.8 production wrapper around the proven V16.7 web-reasoning lane.
//
// Why a wrapper instead of another controller: the Pi controller continues to
// own ONE advisor lane and ONE executor. We start the existing consultation as
// a promise, overlap it only with deterministic source-read-only preparation,
// then hold the result behind a generation/workspace Decision Barrier. No Pi
// model turn starts inside this module.

import {
  createWebReasoningLane as createBaseWebReasoningLane,
  WEB_LANE_OUTCOME,
} from "./web-reasoning-lane.mjs"
import { WEB_REASONING_UNAVAILABLE } from "./web-reasoning-provider.mjs"
import {
  V16_8_DEFAULT_HARD_DEADLINE_MS,
  V16_8_DEFAULT_SOFT_DEADLINE_MS,
  buildExecutorAdvisorCapsule,
  captureBarrierFingerprint,
  createLinkedDeadline,
  deterministicResolutionProof,
  evaluateDecisionBarrier,
  overlapTelemetry,
  phase0FastGrounding,
  renderExecutorAdvisorCapsule,
  startReadOnlyLocalPrep,
} from "./web-decision-barrier-v16-8.mjs"

export * from "./web-reasoning-lane.mjs"

function boundedDeadline(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function abortError(signal) {
  const reason = signal?.reason
  const error = reason instanceof Error ? reason : new Error("web-advisor-aborted")
  if (!error.code) error.code = "ABORT_ERR"
  return error
}

function raceAdapterOperation(operation, signal, { onAbort, onLate } = {}) {
  if (!signal) return operation
  if (signal.aborted) {
    try { onAbort?.() } catch {}
    operation.then((value) => onLate?.(value)).catch(() => null)
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener?.("abort", handleAbort)
      fn(value)
    }
    const handleAbort = () => {
      if (settled) return
      try {
        const cleanup = onAbort?.()
        Promise.resolve(cleanup).catch(() => null)
      } catch {}
      finish(reject, abortError(signal))
    }
    signal.addEventListener?.("abort", handleAbort, { once: true })
    operation.then(
      (value) => {
        if (settled) {
          try { onLate?.(value) } catch {}
          return
        }
        finish(resolve, value)
      },
      (error) => {
        if (settled) return
        finish(reject, error)
      },
    )
  })
}

function adapterWithSignal(adapter, signalRef) {
  if (!adapter || typeof adapter !== "object") return adapter
  const currentSignal = (explicit) => explicit || signalRef.current || undefined
  return {
    ...adapter,
    async capability(options = {}) {
      const signal = currentSignal(options.signal)
      const operation = Promise.resolve().then(() => adapter.capability({ ...options, signal }))
      return raceAdapterOperation(operation, signal)
    },
    async startSession(input = {}) {
      const signal = currentSignal(input.signal)
      const operation = Promise.resolve().then(() => adapter.startSession({ ...input, signal }))
      return raceAdapterOperation(operation, signal, {
        // If a browser session materializes after the generation was aborted,
        // close it immediately rather than leaving a late session alive.
        onLate: (session) => adapter.closeSession?.(session),
      })
    },
    async consult(session, packet, options = {}) {
      const signal = currentSignal(options.signal)
      const operation = Promise.resolve().then(() => adapter.consult(session, packet, { ...options, signal }))
      return raceAdapterOperation(operation, signal, {
        // DeepSeek Web owns a real browser session. Closing it is the strongest
        // cooperative cancellation primitive available when an in-page poll
        // does not itself consume AbortSignal.
        onAbort: () => adapter.closeSession?.(session),
      })
    },
    async followUp(session, delta, options = {}) {
      const signal = currentSignal(options.signal)
      const operation = Promise.resolve().then(() => adapter.followUp(session, delta, { ...options, signal }))
      return raceAdapterOperation(operation, signal, {
        onAbort: () => adapter.closeSession?.(session),
      })
    },
    async closeSession(session) {
      return adapter.closeSession(session)
    },
  }
}

function normalizeAcceptedLaneResult(result) {
  if (!result || typeof result !== "object") return result
  return result.outcome === WEB_LANE_OUTCOME.ADVISED
    ? { ...result, outcome: "advice-accepted" }
    : result
}

function withUpstreamGrounding(result, input, hasWorkspaceRoot) {
  if (hasWorkspaceRoot || !result || typeof result !== "object") return result
  // NEVER invent `present` claims. The caller's `knownFiles` list is an INPUT to
  // the local verifier, not its output: an earlier revision rewrote every entry
  // to `status: "present"`, which turned an unverified path into "evidence" the
  // capsule then trusted as executor-ready. A real binding produced by
  // `bindClaimsToLocalEvidence` is preserved untouched; when there is none, the
  // claims are recorded honestly as `unverified` so the capsule fails closed.
  const real = result.evidenceBinding?.claims
  if (Array.isArray(real) && real.length > 0) return result
  const claims = (input.knownFiles || [])
    .map((row) => typeof row === "string" ? row : row?.path)
    .map((path) => String(path || "").trim())
    .filter(Boolean)
    .map((path) => ({ path, status: "unverified", reason: "no-workspace-proof" }))
  return claims.length ? { ...result, evidenceBinding: { claims } } : result
}

function timeoutLaneResult(base, options, reason, details = {}) {
  const forced = base.mode === "force"
  return {
    schemaVersion: base.schemaVersion || 1,
    kind: "ues-web-reasoning-lane",
    mode: base.mode,
    provider: base.providerId,
    live: options.live === true,
    outcome: forced ? WEB_LANE_OUTCOME.UNAVAILABLE : WEB_LANE_OUTCOME.FALLBACK,
    reason,
    code: forced ? WEB_REASONING_UNAVAILABLE : null,
    fallbackToLocal: !forced,
    consulted: false,
    advisorText: null,
    advisorCapsule: null,
    advisorCapsuleV16_8: null,
    isTaskVerdict: false,
    canProducePass: false,
    telemetry: base.telemetry?.snapshot?.() || null,
    ...details,
  }
}

function lateCleanup(base, promise) {
  promise.then(async () => {
    try { base.undoConsultation?.() } catch {}
    // A provider that ignored AbortSignal may complete later with a live
    // session. The stale generation can never be applied, so reclaim that
    // session -- but do NOT call base.close(): that sets `finished = true` and
    // permanently bricks the lane, and it closes whatever session the lane
    // holds AT THAT MOMENT, which can belong to a NEWER generation that is
    // still running. Releasing only the current session keeps the fenced
    // generation's resources from leaking without ending the lane.
    if (typeof base.releaseSession === "function") await base.releaseSession().catch(() => null)
    else await base.close?.().catch(() => null)
  }).catch(() => null)
}

/**
 * Production V16.8 web lane.
 *
 * The underlying V16.7 lane still owns escalation, packet budgets, provider
 * trust, local advice verification and follow-up accounting. V16.8 adds only:
 * async overlap with deterministic local prep, deadlines/cancellation,
 * generation + workspace fencing, and a compact executor-facing capsule.
 */
export function createWebReasoningLane(options = {}) {
  const signalRef = { current: null }
  const wrappedAdapters = Array.isArray(options.adapters)
    ? options.adapters.map((adapter) => adapterWithSignal(adapter, signalRef))
    : []
  const base = createBaseWebReasoningLane({ ...options, adapters: wrappedAdapters })
  let generation = 0
  let activeGeneration = 0
  let staleDiscards = 0
  let advisorAborts = 0
  let lastV16_8 = null

  async function runBarrier(kind, input, invoke) {
    const startedAt = Date.now()
    generation += 1
    const consultGeneration = generation
    activeGeneration = consultGeneration
    let phase0
    try {
      phase0 = phase0FastGrounding(input)
    } catch (error) {
      const tagged = new Error("web-reasoning escalation failed")
      tagged.name = "WebEscalationError"
      tagged.uesConsultationReason = "escalation-error"
      tagged.cause = error
      throw tagged
    }
    const softDeadlineMs = boundedDeadline(
      input.softDeadlineMs ?? options.softDeadlineMs,
      V16_8_DEFAULT_SOFT_DEADLINE_MS,
      100,
      120_000,
    )
    const hardDeadlineMs = boundedDeadline(
      input.hardDeadlineMs ?? options.hardDeadlineMs,
      V16_8_DEFAULT_HARD_DEADLINE_MS,
      250,
      180_000,
    )

    let prep = null
    const deadline = createLinkedDeadline({
      parentSignal: input.signal || options.signal,
      softDeadlineMs: Math.min(softDeadlineMs, Math.max(100, hardDeadlineMs - 1)),
      hardDeadlineMs,
      onSoftDeadline: () => prep?.abortOptional?.("soft-deadline"),
    })
    signalRef.current = deadline.signal
    prep = startReadOnlyLocalPrep(input, {
      phase0,
      signal: deadline.signal,
      workspaceRoot: input.workspaceRoot || options.workspaceRoot,
      maxFiles: options.localPrepMaxFiles,
      maxTests: options.localPrepMaxTests,
    })

    // Circuit breaker is proof-driven only. No heuristic may abort the advisor.
    // FORCE is an explicit operator request for an external consultation, so the
    // local proof fast path never silently overrides FORCE semantics.
    const deterministic = deterministicResolutionProof(input)
    if (deterministic.proven && base.mode !== "force") {
      advisorAborts += 1
      activeGeneration += 1
      prep.abortOptional("deterministic-resolution-proven")
      if (!deadline.signal.aborted) deadline.controller.abort(new Error("deterministic-resolution-proven"))
      deadline.close()
      signalRef.current = null
      lastV16_8 = {
        phase0,
        decisionBarrier: { passed: false, reasons: ["deterministic-resolution-proven"], stale: false },
        deterministicResolution: deterministic,
      }
      return timeoutLaneResult(base, options, "deterministic-local-resolution", {
        fallbackToLocal: true,
        circuitBreaker: deterministic,
        v16_8: lastV16_8,
      })
    }

    const advisorStartedAt = Date.now()
    const advisorPromise = Promise.resolve()
      .then(() => invoke({ ...input, signal: deadline.signal }))
      .then(
        (value) => ({ ok: true, value, finishedAt: Date.now() }),
        (error) => ({ ok: false, error, finishedAt: Date.now() }),
      )
    const localStartedAt = Date.now()
    const criticalPromise = prep.critical.then(
      (value) => ({ ok: true, value, finishedAt: Date.now() }),
      (error) => ({ ok: false, error, finishedAt: Date.now() }),
    )
    let optionalSettled = false
    let optionalValue = null
    const optionalPromise = prep.optional.then(
      (value) => { optionalSettled = true; optionalValue = value; return value },
      () => { optionalSettled = true; optionalValue = null; return null },
    )

    const joined = Promise.all([advisorPromise, criticalPromise]).then(([advisor, critical]) => ({
      timedOut: false,
      advisor,
      critical,
    }))
    const settled = await Promise.race([joined, deadline.hardPromise])

    if (settled?.timedOut || deadline.hardTimedOut) {
      advisorAborts += 1
      staleDiscards += 1
      activeGeneration += 1
      prep.abortOptional("hard-deadline")
      if (!deadline.signal.aborted) deadline.controller.abort(new Error("web-advisor-hard-deadline"))
      lateCleanup(base, advisorPromise)
      deadline.close()
      signalRef.current = null
      const finishedAt = Date.now()
      const v16_8 = {
        phase0,
        decisionBarrier: { passed: false, reasons: ["web-advisor-hard-deadline"], stale: true },
        overlapTelemetry: overlapTelemetry({
          startedAt,
          finishedAt,
          advisorStartedAt,
          advisorFinishedAt: finishedAt,
          localStartedAt,
          localFinishedAt: finishedAt,
          barrierAt: finishedAt,
          phase0Ms: phase0.durationMs,
          staleDiscard: true,
          advisorAborted: true,
          // The advisor was aborted, so it never reported a completion time.
          // Reporting the abort instant as `advisor_ms` would present a
          // synthesized duration as a measured one.
          advisorCompleted: false,
        }),
      }
      lastV16_8 = v16_8
      return timeoutLaneResult(base, options, "web-advisor-hard-deadline", { v16_8 })
    }

    deadline.close()
    signalRef.current = null
    const advisorFinishedAt = settled.advisor.finishedAt
    const localFinishedAt = settled.critical.finishedAt
    if (!optionalSettled) prep.abortOptional("decision-barrier-ready")
    await optionalPromise.catch(() => null)

    if (!settled.advisor.ok) throw settled.advisor.error
    if (!settled.critical.ok) {
      return timeoutLaneResult(base, options, "local-barrier-prep-failed", {
        v16_8: { phase0, decisionBarrier: { passed: false, reasons: ["local-barrier-prep-failed"], stale: false } },
      })
    }

    const result = settled.advisor.value
    const critical = settled.critical.value
    const afterFingerprint = captureBarrierFingerprint(prep.root)
    const acceptedShape = withUpstreamGrounding(
      normalizeAcceptedLaneResult(result),
      input,
      Boolean(prep.root),
    )
    const capsule = buildExecutorAdvisorCapsule(acceptedShape, {
      critical: prep.root ? critical : { ...critical, fileRows: [] },
      optional: optionalValue,
      afterFingerprint,
    }, {
      consultGeneration,
      maxChars: options.capsuleMaxChars,
    })
    const barrier = evaluateDecisionBarrier({
      result: acceptedShape,
      consultGeneration,
      activeGeneration,
      beforeFingerprint: prep.beforeFingerprint,
      afterFingerprint,
      capsule,
      workspaceRequired: prep.workspace?.required === true,
    })
    const barrierAt = Date.now()
    const oldAdvisorChars = String(result?.advisorText || "").length
    const compactText = barrier.passed ? renderExecutorAdvisorCapsule(capsule) : null
    const stale = barrier.stale === true
    if (stale) staleDiscards += 1

    const metrics = overlapTelemetry({
      startedAt,
      finishedAt: barrierAt,
      advisorStartedAt,
      advisorFinishedAt,
      localStartedAt,
      localFinishedAt,
      barrierAt,
      phase0Ms: phase0.durationMs,
      capsuleChars: compactText?.length || 0,
      previousAdvisorChars: oldAdvisorChars,
      staleDiscard: stale,
      advisorAborted: false,
    })
    const v16_8 = {
      schemaVersion: 1,
      kind: "ues-v16-8-advisor-overlap",
      consultKind: kind,
      consultGeneration,
      activeGeneration,
      phase0,
      localPrep: {
        workspaceRootSource: prep.workspace?.source || "unavailable",
        workspaceFingerprintBefore: prep.beforeFingerprint?.fingerprint || null,
        workspaceFingerprintAfter: afterFingerprint?.fingerprint || null,
        validFiles: critical.validFiles || [],
        generatedFiles: critical.generatedFiles || [],
        readOnlyFiles: critical.readOnlyFiles || [],
        affectedTests: (optionalValue?.tests || []).slice(0, 20),
        testsExecuted: 0,
        sourceMutationAllowed: false,
      },
      decisionBarrier: barrier,
      capsule: capsule ? {
        status: capsule.status,
        reason: capsule.reason,
        chars: capsule.chars,
        rejectedTargets: capsule.rejectedTargets,
      } : null,
      overlapTelemetry: metrics,
      staleDiscards,
      advisorAborts,
    }
    lastV16_8 = v16_8

    // A rejected/unavailable/skipped base result already has no advisorText;
    // keep its original outcome. The barrier only converts an ACCEPTED advice
    // into fallback/unavailable when generation/workspace/feasibility is stale.
    if (result?.outcome !== WEB_LANE_OUTCOME.ADVISED) {
      return { ...result, v16_8 }
    }
    if (!barrier.passed || !compactText) {
      try { base.undoConsultation?.() } catch {}
      const forced = base.mode === "force"
      return {
        ...result,
        outcome: forced ? WEB_LANE_OUTCOME.UNAVAILABLE : WEB_LANE_OUTCOME.FALLBACK,
        reason: barrier.reasons[0] || "decision-barrier-rejected",
        code: forced ? WEB_REASONING_UNAVAILABLE : null,
        fallbackToLocal: !forced,
        advisorText: null,
        advisorCapsuleV16_8: capsule,
        decisionBarrier: barrier,
        v16_8,
      }
    }

    return {
      ...result,
      // This is the ONLY model-facing advisor block from V16.8. The historical
      // long prose remains measurable as `oldAdvisorChars` but is not injected.
      advisorText: compactText,
      advisorCapsuleV16_8: capsule,
      decisionBarrier: barrier,
      v16_8,
    }
  }

  return {
    ...base,
    schemaVersion: base.schemaVersion,
    mode: base.mode,
    providerId: base.providerId,
    maxConsultations: base.maxConsultations,
    maxFollowUps: base.maxFollowUps,
    followUpAllowance: base.followUpAllowance,
    telemetry: base.telemetry,
    async consult(input = {}) {
      return runBarrier("consult", input, (next) => base.consult(next))
    },
    async followUp(input = {}) {
      return runBarrier("follow-up", input, (next) => base.followUp(next))
    },
    state() {
      return {
        ...base.state(),
        v16_8: {
          generation,
          activeGeneration,
          staleDiscards,
          advisorAborts,
          lastDecisionBarrier: lastV16_8?.decisionBarrier || null,
          lastOverlapTelemetry: lastV16_8?.overlapTelemetry || null,
        },
      }
    },
    snapshot() {
      return {
        ...base.snapshot(),
        v16_8: {
          generation,
          activeGeneration,
          staleDiscards,
          advisorAborts,
          last: lastV16_8,
        },
      }
    },
  }
}
