// V16.9 evidence broker.
//
// WHY THIS MODULE EXISTS
//
// The V16.6 evidence-request loop lived inline in `pi/extensions/ues.ts`
// (`serveEvidenceRequests`). That closure owned four separate responsibilities
// at once: parsing the advisor's request, authorizing it, GATHERING the local
// sources (workspace diff, repo summary, verifier output), and preparing the
// bounded/redacted delta. A closure inside a 10k-line controller is not an
// owner: it cannot be tested in isolation and it silently couples the evidence
// policy to the controller's local variables (`cwd`, `recentFailure`,
// `controllerWorkspaceState`).
//
// This module is the single owner of that loop. It does NOT re-implement any
// primitive: parsing, authorization, workspace containment, redaction and the
// per-run budget stay in `lib/deepseek-evidence-requests.mjs`, which remains the
// ONE authority path. The broker adds only:
//
//   * a source REGISTRY: the caller declares how each allowlisted kind is
//     gathered, so the broker never guesses;
//   * a single `serve()` entry point that returns a bounded delta string plus a
//     receipt, and never throws;
//   * an honest fail-closed posture: an unknown source or a denied request is
//     REPORTED, never silently narrowed;
//   * V16.9: an OPTIONAL shared-context ledger (`lib/shared-context-ledger.mjs`)
//     that records the exact evidence the advisor has ALREADY been shown, so a
//     repeated request whose content hash did not change is delivered ONCE and
//     then referenced by its `evidence_id` instead of re-sent. The ledger is a
//     primitive OWNED BY the broker here - it is not a second evidence owner,
//     and the broker never uses it to refuse a request the advisor made (the
//     advisor is never forbidden from re-asking; it simply is not re-charged
//     the full text for unchanged bytes).
//
// It owns NO tool execution. The advisor can ASK; it can never TAKE.

import {
  EVIDENCE_KIND_LIST,
  createEvidenceRequestBudget,
  prepareEvidenceDelta,
} from "./deepseek-evidence-requests.mjs"
import { containsUnmaskedSecret } from "./secret-redaction.mjs"

export const EVIDENCE_BROKER_SCHEMA_VERSION = 1
export const EVIDENCE_BROKER_POLICY = "evidence-broker-v16-9"

// The broker caps the TOTAL rendered delta it will hand back to the caller, in
// addition to the per-request char budgets the budget object already enforces.
const DEFAULT_MAX_RENDERED_CHARS = 4_000
const MAX_ADVISOR_TEXT_CHARS = 60_000

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Build an evidence broker for one run.
 *
 * `options.sources` maps an allowlisted kind to a gatherer function
 * `(context) => string`. A kind with no source is reported as
 * `unavailable-kind` rather than returning an empty delta that looks like
 * "nothing to send".
 */
export function createEvidenceBroker(options = {}) {
  const runId = String(options.runId || "run")
  const root = options.root ? String(options.root) : null
  const sources = new Map()
  for (const [kind, gather] of Object.entries(options.sources || {})) {
    if (typeof gather === "function") sources.set(String(kind), gather)
  }
  const budget = options.budget || createEvidenceRequestBudget({ runId })
  // V16.9: the shared-context ledger is INJECTED, never constructed here, so the
  // broker stays free of a static import cycle and the caller (which owns the
  // run lifecycle and therefore knows the workspace scope) decides the ledger's
  // lifetime. A broker without a ledger behaves exactly as V16.9-before: every
  // authorized delta is rendered in full.
  const ledger = options.ledger && typeof options.ledger.planShare === "function" ? options.ledger : null
  const maxRenderedChars = boundedInt(options.maxRenderedChars, DEFAULT_MAX_RENDERED_CHARS, 200, 60_000)
  let servedExchanges = 0
  let totalDeltasSent = 0
  let totalDeltasDenied = 0
  let totalEvidenceResent = 0
  let totalEvidenceReused = 0
  let totalEvidenceDelta = 0
  let totalReusedChars = 0
  let totalDeltaChars = 0
  const lastReceipts = []

  /**
   * Serve the evidence requests found in one advisor reply.
   *
   * @param {string} advisorText the advisor's own reply text
   * @param {object} [context] values the gatherers may read (never secrets)
   * @returns {{ requests: number, authorized: number, deltasSent: number,
   *             deltaText: string, protocol: string, receipt: object,
   *             refusal?: object }}
   */
  function serve(advisorText, context = {}) {
    servedExchanges += 1
    budget.beginExchange()
    const parsed = budget.parse(String(advisorText || "").slice(0, MAX_ADVISOR_TEXT_CHARS))
    const receipt = {
      schemaVersion: EVIDENCE_BROKER_SCHEMA_VERSION,
      kind: "ues-v16-9-evidence-broker",
      policy: EVIDENCE_BROKER_POLICY,
      runId,
      requestsRequested: parsed.requests.length,
      requestsRejectedByParse: parsed.rejected.length,
      authorized: 0,
      denied: 0,
      unavailableKinds: [],
      deltasSent: 0,
      deltaChars: 0,
      // V16.9 shared-context ledger accounting. Zero unless a ledger is wired.
      evidenceResent: 0,
      evidenceReused: 0,
      evidenceDelta: 0,
      reusedChars: 0,
      deltaBytes: 0,
      reusedEvidenceIds: [],
      protocol: parsed.protocol,
      exhausted: false,
    }
    if (!parsed.requests.length) {
      lastReceipts.push(receipt)
      if (lastReceipts.length > 16) lastReceipts.shift()
      return { requests: 0, authorized: 0, deltasSent: 0, deltaText: "", protocol: parsed.protocol, receipt }
    }

    const deltas = []
    for (const request of parsed.requests) {
      const decision = budget.authorize(
        { kind: request.kind, target: request.target || null, reason: request.reason || null },
        { root },
      )
      if (!decision.allowed) {
        receipt.denied += 1
        continue
      }
      const gather = sources.get(String(request.kind))
      if (typeof gather !== "function") {
        receipt.unavailableKinds.push(String(request.kind))
        receipt.denied += 1
        continue
      }
      receipt.authorized += 1
      let raw
      try {
        raw = gather({ kind: request.kind, request, context })
      } catch {
        raw = ""
      }
      if (raw === undefined || raw === null || raw === "") {
        // An authorized kind whose source produced nothing is reported, not
        // padded with a fabricated placeholder.
        receipt.unavailableKinds.push(String(request.kind))
        continue
      }
      // Decide NEW/CHANGED/UNCHANGED BEFORE charging the run budget, so a
      // repeated, UNCHANGED request that is delivered as an `evidence_id`
      // marker is NOT charged the bytes it never re-sent. The probe uses the
      // authority primitive `prepareEvidenceDelta` directly (it does not touch
      // the budget); the budget is charged only when bytes are actually sent.
      const probe = prepareEvidenceDelta({ kind: request.kind, text: String(raw), maxChars: decision.maxChars })
      if (!probe.ok) {
        receipt.denied += 1
        continue
      }
      // Defense in depth: the delta is already redacted by the primitive, but a
      // second INDEPENDENT scan re-checks the rendered text for any UNMASKED
      // secret. A delta that still contains an unmasked secret is dropped
      // rather than sent.
      //
      // The predicate is `containsUnmaskedSecret` (the same one
      // `deepseek-evidence-requests.mjs` uses), NOT `redactSecrets(...).redacted`:
      // re-running the redactor over its own mask reports `redacted: true` again
      // for already-masked text, which would falsely DROP every legitimately
      // redacted delta.
      if (containsUnmaskedSecret(probe.text)) {
        receipt.denied += 1
        continue
      }
      // V16.9: the ledger answers "has the advisor already been shown EXACTLY
      // this content?". The ledger KEY is the STABLE request identity
      // (`kind:target`), so the ledger can distinguish UNCHANGED (same bytes) from
      // CHANGED (same target, different bytes) - keying by the content hash would
      // make every change look like a brand-new block and defeat the whole point.
      // The `evidence_id` marker still carries the CURRENT content hash
      // (`probe.evidenceRef`) so the advisor can cite exactly which revision it
      // holds. When no ledger is wired the block is always sent in full, so
      // behaviour is byte-identical to the pre-ledger broker.
      if (ledger) {
        const ledgerKey = `${request.kind}:${request.target || ""}`
        const share = ledger.planShare([
          { key: ledgerKey, kind: request.kind, text: probe.text },
        ])
        const plan = share.toSend[0]
        if (!plan) {
          // Unchanged since the advisor last saw it: deliver the reference, not
          // the bytes. The advisor can always re-ask; it is never charged twice
          // for identical evidence. HONESTY GUARD: only substitute the marker
          // when it is actually SMALLER than the bytes it replaces - for a tiny
          // block a hash marker can be longer than the content, in which case
          // reuse would INCREASE chars and must not be claimed as a saving.
          const marker = `### requested evidence: ${request.kind} (unchanged; evidence_id=${probe.evidenceRef})`
          if (marker.length < probe.text.length) {
            deltas.push(marker)
            receipt.deltasSent += 1
            receipt.evidenceReused += 1
            receipt.reusedChars += probe.text.length - marker.length
            receipt.reusedEvidenceIds.push(probe.evidenceRef)
            totalDeltasSent += 1
            totalEvidenceReused += 1
            totalReusedChars += probe.text.length - marker.length
            continue
          }
        }
        if (plan && plan.state === "CHANGED" && plan.deltaText) {
          // A bounded line delta is cheaper than the whole block AND tells the
          // advisor exactly what moved. HONESTY GUARD: only use the delta when
          // it is actually smaller than re-sending the block; otherwise fall
          // through and re-send the full bytes. It is still charged to the run
          // budget (bytes leave the machine) via the SAME authority path.
          const deltaBody = String(plan.deltaText)
          const deltaMarker = `### requested evidence: ${request.kind} (changed; evidence_id=${probe.evidenceRef}; delta)\n`
          if (deltaBody.length < probe.text.length) {
            const charged = budget.prepare({ kind: request.kind, text: deltaBody, maxChars: decision.maxChars })
            if (!charged.ok) {
              receipt.denied += 1
              continue
            }
            deltas.push(`${deltaMarker}${charged.text}`)
            receipt.deltasSent += 1
            receipt.evidenceDelta += 1
            receipt.deltaBytes += charged.text.length
            totalDeltasSent += 1
            totalEvidenceDelta += 1
            totalDeltaChars += charged.text.length
            continue
          }
        }
      }
      // Bytes leave the machine: charge the run budget now. `budget.prepare`
      // re-derives the identical delta from the same inputs, so the text sent
      // is byte-identical to the probe.
      const delta = budget.prepare({ kind: request.kind, text: String(raw), maxChars: decision.maxChars })
      if (!delta.ok) {
        receipt.denied += 1
        continue
      }
      deltas.push(`### requested evidence: ${request.kind}\n${delta.text}`)
      receipt.deltasSent += 1
      receipt.evidenceResent += 1
      totalDeltasSent += 1
      totalEvidenceResent += 1
    }

    const refusal = budget.refusal()
    receipt.exhausted = refusal.exhausted
    receipt.remainingRunChars = refusal.remainingRunChars
    const joined = deltas.join("\n\n")
    const deltaText = joined.length > maxRenderedChars
      ? joined.slice(0, Math.max(0, maxRenderedChars - 16)) + "\n[delta truncated]"
      : joined
    receipt.deltaChars = deltaText.length
    totalDeltasDenied += receipt.denied
    lastReceipts.push(receipt)
    if (lastReceipts.length > 16) lastReceipts.shift()

    return {
      requests: parsed.requests.length,
      authorized: receipt.authorized,
      deltasSent: receipt.deltasSent,
      deltaText,
      protocol: parsed.protocol,
      refusal,
      receipt,
    }
  }

  return {
    schemaVersion: EVIDENCE_BROKER_SCHEMA_VERSION,
    policy: EVIDENCE_BROKER_POLICY,
    runId,
    root,
    allowlistedKinds: [...EVIDENCE_KIND_LIST],
    serve,
    /** The single authority path for parsing is the budget's own parser. */
    parse(text, parseOptions) {
      return budget.parse(text, parseOptions)
    },
    telemetry() {
      return {
        schemaVersion: EVIDENCE_BROKER_SCHEMA_VERSION,
        policy: EVIDENCE_BROKER_POLICY,
        runId,
        servedExchanges,
        totalDeltasSent,
        totalDeltasDenied,
        // V16.9 shared-context ledger counters (MEASURED character lengths).
        totalEvidenceResent,
        totalEvidenceReused,
        totalEvidenceDelta,
        totalReusedChars,
        totalDeltaChars,
        ledgerWired: ledger != null,
        budget: budget.telemetry(),
      }
    },
    state() {
      return {
        schemaVersion: EVIDENCE_BROKER_SCHEMA_VERSION,
        policy: EVIDENCE_BROKER_POLICY,
        runId,
        registeredKinds: [...sources.keys()],
        servedExchanges,
        totalEvidenceResent,
        totalEvidenceReused,
        totalEvidenceDelta,
        totalReusedChars,
        totalDeltaChars,
        ledgerWired: ledger != null,
        ledger: ledger ? ledger.state() : null,
        lastReceipts: lastReceipts.slice(-4),
      }
    },
    reset() {
      servedExchanges = 0
      totalDeltasSent = 0
      totalDeltasDenied = 0
      totalEvidenceResent = 0
      totalEvidenceReused = 0
      totalEvidenceDelta = 0
      totalReusedChars = 0
      totalDeltaChars = 0
      lastReceipts.length = 0
      budget.reset()
      if (ledger && typeof ledger.reset === "function") ledger.reset()
    },
  }
}
