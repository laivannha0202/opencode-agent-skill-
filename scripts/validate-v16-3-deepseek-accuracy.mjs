#!/usr/bin/env node
// V16.3 — final pre-packaging DeepSeek accuracy validation.
//
// WHAT THIS MEASURES: advisor correctness and verifier safety.
//   - does the advisor's conclusion match the ground truth written down in the
//     local source/evidence BEFORE the advice was produced?
//   - does the local verifier accept only advice that the source evidence
//     supports, and reject advice that it does not?
//   - does AUTO route a trivial task to a local skip and a hard task to an
//     escalation?
//
// WHAT THIS DOES NOT DO:
//   - no network, no browser, no live DeepSeek session, no /ues-run, no
//     ues_execute; nothing here dispatches a tool against a real provider.
//   - no publish, no push, no version bump, no release step.
//   - no verifier-policy change. Every verification object this run produces is
//     the same `verifyLocalAdvice` result production uses, and this harness
//     fails if any of them can produce a PASS.
//
// FIXTURES: every case is synthetic with a ground truth fixed in advance — a
// small source tree written to disk, a local evidence row, and a diagnosis id
// embedded in the fixture source. The advisor is a deterministic
// evidence-reading provider double behind the real `WebReasoningProvider`
// interface: it reads the Decision Packet (or follow-up delta) it is actually
// handed and answers from the evidence inside it, so an incorrect conclusion
// can only come from a packet that lost the evidence. Case 5 is the deliberate
// exception: a deterministic WRONG advice fixture whose whole purpose is to be
// rejected by the local verifier.
//
// Usage:
//   node scripts/validate-v16-3-deepseek-accuracy.mjs [--skip-local-tests]

import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import { buildDecisionPacket, buildFollowUpDelta, clearDecisionPacketCache } from "../lib/decision-packet.mjs"
import {
  WEB_ESCALATION_MODE,
  createWebReasoningTelemetry,
  decideWebEscalation,
  runWebConsultation,
  runWebFollowUp,
} from "../lib/web-reasoning-escalation.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workDir = path.join(root, ".ues-work", "v16.3-deepseek-accuracy-validation")
const skipLocalTests = process.argv.includes("--skip-local-tests")

const PROVIDER_ID = "deepseek-web"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const norm = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").trim()

function adviceText(advice = {}) {
  return [
    advice.summary ?? "",
    ...(advice.hypotheses || []),
    ...(advice.recommendedApproach || []),
    ...(advice.verificationSuggestions || []),
  ].join(" \n ")
}

// Ground truth is evaluated against the advice, never against the verifier.
// `fileOk` requires the diagnosis file the fixture source names; `tokenOk`
// requires the diagnosis id the fixture source carries; `nearMissChosen`
// catches an advisor that commits to the plausible-but-unsupported alternative.
function evaluateAdvice(advice, groundTruth) {
  const files = (advice?.filesToInspect || []).map(norm)
  const missingFiles = (groundTruth.files || []).filter((file) => !files.includes(file))
  const text = adviceText(advice)
  const primary = String((advice?.hypotheses || [])[0] || "")
  const fileOk = missingFiles.length === 0
  const tokenOk = !groundTruth.token || text.includes(groundTruth.token)
  const nearMissChosen = Boolean(groundTruth.nearMissToken) && primary.includes(groundTruth.nearMissToken)
  return {
    correct: fileOk && tokenOk && !nearMissChosen,
    fileOk,
    tokenOk,
    nearMissChosen,
    missingFiles,
  }
}

// Source evidence for an ACCEPTED conclusion must be re-read from disk: the
// diagnosis file exists and carries the ground-truth diagnosis id. Acceptance
// without this would be an acceptance on the advisor's word alone.
async function sourceEvidenceSupports(caseDir, groundTruth) {
  const rows = []
  for (const file of groundTruth.files || []) {
    let text = null
    try {
      text = await readFile(path.join(caseDir, file), "utf8")
    } catch {
      rows.push({ file, exists: false, carriesDiagnosis: false })
      continue
    }
    rows.push({
      file,
      exists: true,
      carriesDiagnosis: groundTruth.sourceMarker ? text.includes(groundTruth.sourceMarker) : true,
    })
  }
  return {
    supported: rows.every((row) => row.exists && row.carriesDiagnosis),
    files: rows,
  }
}

function findFalsePass(node, at = "result", acc = []) {
  if (!node || typeof node !== "object") return acc
  if (Array.isArray(node)) {
    node.forEach((row, index) => findFalsePass(row, `${at}[${index}]`, acc))
    return acc
  }
  for (const [key, value] of Object.entries(node)) {
    if ((key === "canProducePass" || key === "isTaskVerdict") && value === true) acc.push(`${at}.${key}=true`)
    else if (value && typeof value === "object") findFalsePass(value, `${at}.${key}`, acc)
  }
  return acc
}

function rejectionSummary(verification) {
  if (!verification) return null
  const reasons = (verification.rejections || []).map((row) => row.rejection || row.reason || "unknown")
  return reasons.length ? [...new Set(reasons)].join(", ") : null
}

// ---------------------------------------------------------------------------
// fixtures — source trees on disk, ground truth fixed in advance
// ---------------------------------------------------------------------------

const FIXTURES = {
  "case-1-clear-root-cause": {
    "src/retry-budget.mjs": [
      "// ground-truth-diagnosis: retry-budget-off-by-one",
      "export function retryBudget(retries) {",
      "  return retries + 1",
      "}",
      "",
    ].join("\n"),
  },
  "case-2-ambiguous-near-miss": {
    // The plausible near-miss. It exists, it is a real alternative, and the
    // local evidence does not support it.
    "src/cache-key.mjs": [
      "// plausible-alternative: cache-key-collision (not supported by local evidence)",
      "export function cacheKey(parts) { return parts.join('|') }",
      "",
    ].join("\n"),
    "src/cache-ttl.mjs": [
      "// ground-truth-diagnosis: cache-ttl-normalization-missing",
      "export function ttlSeconds(config) { return config.ttlMs } // caller expects seconds",
      "",
    ].join("\n"),
  },
  "case-3-easy-grounded": {
    "src/parse-config.mjs": [
      "// ground-truth-diagnosis: missing-semicolon (trivial, one file)",
      "export function parseConfig(line) { return JSON.parse(line) }",
      "",
    ].join("\n"),
  },
  "case-4-hard-multi-subsystem": {
    "src/api/session-router.mjs": [
      "// ground-truth-diagnosis: session-lease-expiry-race",
      "export function authorize(session) { return session.leaseEndsAt > Date.now() }",
      "",
    ].join("\n"),
    "src/store/session-store.mjs": [
      "// ground-truth-diagnosis: session-lease-expiry-race",
      "export function lease(store, id) { return store.get(id) }",
      "",
    ].join("\n"),
    "src/ui/session-badge.mjs": [
      "// ground-truth-diagnosis: session-lease-expiry-race",
      "export function badge(session) { return session.state }",
      "",
    ].join("\n"),
  },
  "case-5-wrong-advisor-output": {
    "src/counter-store.mjs": [
      "// ground-truth-diagnosis: double-increment-on-rehydrate",
      "export function applyRehydrate(state, event) { return { ...state, count: state.count + event.count } }",
      "",
    ].join("\n"),
  },
  "case-6-corrective-follow-up": {
    "src/lock-ttl.mjs": [
      "// ground-truth-diagnosis: lock-ttl-never-refreshed",
      "export function lockTtl(config) { return config.ttlMs }",
      "",
    ].join("\n"),
  },
}

// ---------------------------------------------------------------------------
// deterministic, evidence-reading advisor double
// ---------------------------------------------------------------------------

function evidenceBlob(packet) {
  return JSON.stringify(packet?.sections?.failingTestRuntimeEvidence ?? packet?.sections ?? {})
}

function deltaBlob(delta) {
  return JSON.stringify(delta?.sections ?? {})
}

function correctRetryBudgetAdvice() {
  return {
    summary: "Retry budget off-by-one: src/retry-budget.mjs returns retries + 1, so the configured count is exceeded by exactly one.",
    hypotheses: [
      "retry-budget-off-by-one: the budget adds 1 to the configured retry count",
    ],
    recommendedApproach: [
      "Derive the budget from the configured retry count without the +1 increment.",
    ],
    filesToInspect: ["src/retry-budget.mjs"],
    risks: ["Raising the ceiling instead would hide the off-by-one behind a larger budget."],
    edgeCases: ["retries = 0 must produce a budget of 0."],
    verificationSuggestions: ["The unit suite covers budget 0 and budget 4 cases."],
    confidence: 0.86,
  }
}

const ADVISORS = {
  // Case 1: answers only if the packet still carries the local failure evidence.
  "case-1-clear-root-cause": {
    consult(packet) {
      const evidence = evidenceBlob(packet)
      if (!evidence.includes("expected retry budget 4, got 5")) {
        return {
          summary: "No local failure evidence reached the packet; refusing to guess a root cause.",
          hypotheses: ["evidence-missing"],
          recommendedApproach: ["Re-send the failing test evidence."],
          filesToInspect: [],
          risks: [],
          edgeCases: [],
          verificationSuggestions: [],
          confidence: 0.2,
        }
      }
      return correctRetryBudgetAdvice()
    },
  },

  // Case 2: two plausible diagnoses; the packet evidence decides which one it
  // commits to. Without the TTL evidence it commits to the near-miss instead.
  "case-2-ambiguous-near-miss": {
    consult(packet) {
      const evidence = evidenceBlob(packet)
      const ttlEvidence = evidence.includes("300000") && evidence.includes("300 (seconds)")
      if (ttlEvidence) {
        return {
          summary: "Stale cache entries come from missing TTL normalization: the cache compares seconds while the store holds milliseconds.",
          hypotheses: [
            "cache-ttl-normalization-missing: config stores milliseconds but the cache compares seconds",
          ],
          recommendedApproach: [
            "Normalize ttl to seconds at the single boundary in src/cache-ttl.mjs before comparison.",
          ],
          filesToInspect: ["src/cache-ttl.mjs", "src/cache-key.mjs"],
          risks: ["Double normalization would shorten every TTL by 1000x."],
          edgeCases: ["A TTL of exactly 0 must still expire immediately."],
          verificationSuggestions: ["Assert TTL 300 seconds survives a read/write round trip."],
          confidence: 0.81,
        }
      }
      return {
        summary: "Two plausible causes; with no decisive evidence the collision path is the safer guess.",
        hypotheses: ["cache-key-collision: two sessions map to the same key"],
        recommendedApproach: ["Namespace the key by session id."],
        filesToInspect: ["src/cache-key.mjs"],
        risks: ["Changing key shape evicts the whole cache."],
        edgeCases: ["Cold start after a key change."],
        verificationSuggestions: ["Assert two sessions never share a key."],
        confidence: 0.55,
      }
    },
  },

  // Case 4: three subsystems, one shared diagnosis; only answers when every
  // affected file and the shared race evidence reached the packet.
  "case-4-hard-multi-subsystem": {
    consult(packet) {
      const files = (packet?.sections?.relevantFiles || []).map((row) => norm(row?.path ?? row))
      const evidence = evidenceBlob(packet)
      const allPresent = ["src/api/session-router.mjs", "src/store/session-store.mjs", "src/ui/session-badge.mjs"]
        .every((file) => files.includes(file))
      const raceEvidence = evidence.includes("401") && evidence.includes("live lease")
      if (!allPresent || !raceEvidence) {
        return {
          summary: "The cross-subsystem evidence is incomplete; refusing to name a single cause from a partial view.",
          hypotheses: ["incomplete-cross-subsystem-evidence"],
          recommendedApproach: ["Re-send api, store and ui evidence together."],
          filesToInspect: [],
          risks: [],
          edgeCases: [],
          verificationSuggestions: [],
          confidence: 0.2,
        }
      }
      return {
        summary: "session-lease-expiry-race: the api rejects on an expired clock while the store still holds a live lease and the ui renders the stale badge.",
        hypotheses: [
          "session-lease-expiry-race: three subsystems read three different expiry notions",
        ],
        recommendedApproach: [
          "Make the store lease the single expiry authority and derive api and ui state from it.",
        ],
        filesToInspect: [
          "src/api/session-router.mjs",
          "src/store/session-store.mjs",
          "src/ui/session-badge.mjs",
        ],
        risks: ["Moving expiry authority changes the 401 contract for existing clients."],
        edgeCases: ["A lease expiring mid-request must fail closed, not extend."],
        verificationSuggestions: ["Assert api, store and ui agree at lease boundary minus one millisecond."],
        confidence: 0.78,
      }
    },
  },

  // Case 5: deterministic WRONG advice on purpose. It is confident, it names a
  // file, and that file does not exist locally — the local verifier must reject
  // it rather than trust the confidence value.
  "case-5-wrong-advisor-output": {
    consult() {
      return {
        summary: "The double increment comes from the reset protocol: src/counter-reset-protocol.mjs increments on every rehydrate event.",
        hypotheses: ["counter-reset-protocol-double-increment"],
        recommendedApproach: [
          "Change the rehydrate guard in src/counter-reset-protocol.mjs.",
        ],
        filesToInspect: ["src/counter-reset-protocol.mjs"],
        risks: ["None; the reset protocol is the only caller."],
        edgeCases: ["Rehydrate after a cold start."],
        verificationSuggestions: ["Assert the reset protocol emits a single increment."],
        confidence: 0.9,
      }
    },
  },

  // Case 6: the FIRST answer is incomplete (it names a file that does not
  // exist). The follow-up only corrects itself when the verifier's rejection
  // feedback actually reached it in the delta.
  "case-6-corrective-follow-up": {
    consult() {
      return {
        summary: "The lock is released early because src/lock-ttl-cache.mjs clamps the ttl on read.",
        hypotheses: ["lock-ttl-cache-clamps-ttl"],
        recommendedApproach: ["Remove the clamp in src/lock-ttl-cache.mjs."],
        filesToInspect: ["src/lock-ttl-cache.mjs"],
        risks: ["Clamping also protects short locks."],
        edgeCases: ["Ttl below the floor."],
        verificationSuggestions: ["Assert the clamp never fires for a 300000ms ttl."],
        confidence: 0.7,
      }
    },
    followUp(delta) {
      const blob = deltaBlob(delta)
      const sawRejection = blob.includes("referenced-file-not-in-repository")
      const sawEvidence = blob.includes("src/lock-ttl.mjs") && blob.includes("300000")
      if (!sawRejection || !sawEvidence) {
        return {
          summary: "The earlier diagnosis still stands; no new evidence was received.",
          hypotheses: ["lock-ttl-cache-clamps-ttl"],
          recommendedApproach: ["Remove the clamp in src/lock-ttl-cache.mjs."],
          filesToInspect: ["src/lock-ttl-cache.mjs"],
          risks: [],
          edgeCases: [],
          verificationSuggestions: [],
          confidence: 0.7,
        }
      }
      return {
        summary: "Corrected: lock-ttl-never-refreshed — the lock ttl is read once at acquire time and never refreshed, so the lock lapses at t+0 despite ttl=300000.",
        hypotheses: [
          "lock-ttl-never-refreshed: the ttl is captured once and never re-armed while the lock is held",
        ],
        recommendedApproach: [
          "Re-arm the ttl from the store while the lock is held, in src/lock-ttl.mjs.",
        ],
        filesToInspect: ["src/lock-ttl.mjs"],
        risks: ["Re-arming must not extend a lock whose holder already released it."],
        edgeCases: ["Holder crashes between refreshes; the ttl still expires."],
        verificationSuggestions: ["Assert a held lock survives past its original ttl and dies on release."],
        confidence: 0.84,
      }
    },
  },
}

// ---------------------------------------------------------------------------
// case definitions
// ---------------------------------------------------------------------------

const CASES = [
  {
    id: "case-1-clear-root-cause",
    name: "Clear root cause",
    // Accuracy probe: the AUTO routing expectation for this well-grounded
    // one-file fix is SKIP, so the consultation is FORCED to measure advisor
    // correctness independently of routing. AUTO's own decision is still
    // computed and scored below.
    mode: WEB_ESCALATION_MODE.FORCE,
    autoExpected: "skip",
    escalateInput: { localConfidence: 0.9, affectedSubsystems: 1, verifierRetries: 0 },
    groundTruth: {
      diagnosis: "retry-budget-off-by-one",
      files: ["src/retry-budget.mjs"],
      token: "retry-budget-off-by-one",
      sourceMarker: "ground-truth-diagnosis: retry-budget-off-by-one",
      evidenceSummary: "unit suite: expected retry budget 4, got 5 (src/retry-budget.mjs:3)",
    },
    packetInput: {
      originalTask: "Correct the retry budget off-by-one in src/retry-budget.mjs.",
      requirements: ["Retry budget must equal the configured retry count"],
      constraints: ["MUST NOT weaken the verifier", "MUST NOT raise the retry ceiling"],
      verification: ["Unit suite covers retry budget 0 and 4"],
      repoMap: { modules: ["src/retry-budget.mjs"] },
      subsystems: ["retry-policy"],
      relevantFiles: [{ path: "src/retry-budget.mjs", role: "target", score: 0.95 }],
      snippets: [{ path: "src/retry-budget.mjs", text: "return retries + 1" }],
      evidence: [
        { kind: "runtime", source: "unit-suite", text: "retry-budget.test.mjs: expected retry budget 4, got 5 (src/retry-budget.mjs:3)" },
      ],
    },
    knownFiles: ["src/retry-budget.mjs"],
    expected: { deepseekCalled: true, verifier: "accepted", advisorCorrect: true },
  },
  {
    id: "case-2-ambiguous-near-miss",
    name: "Ambiguous near-miss",
    mode: WEB_ESCALATION_MODE.AUTO,
    autoExpected: "escalate",
    escalateInput: { localConfidence: 0.4, affectedSubsystems: 1, verifierRetries: 0 },
    groundTruth: {
      diagnosis: "cache-ttl-normalization-missing",
      files: ["src/cache-ttl.mjs"],
      token: "cache-ttl-normalization",
      nearMissToken: "cache-key-collision",
      sourceMarker: "ground-truth-diagnosis: cache-ttl-normalization-missing",
      evidenceSummary: "unit suite: expected TTL 300 (seconds), got 300000 (milliseconds)",
      alternatives: 2,
    },
    packetInput: {
      originalTask: "Ambiguous root cause: stale cache entries — TTL normalization or a cache-key collision?",
      requirements: ["Pick the cause the local evidence supports"],
      constraints: ["MUST NOT guess without evidence"],
      verification: ["Unit suite covers TTL round trip"],
      repoMap: { modules: ["src/cache-ttl.mjs", "src/cache-key.mjs"] },
      subsystems: ["cache"],
      relevantFiles: [
        { path: "src/cache-ttl.mjs", role: "target", score: 0.9 },
        { path: "src/cache-key.mjs", role: "alternative", score: 0.7 },
      ],
      snippets: [
        { path: "src/cache-ttl.mjs", text: "return config.ttlMs // caller expects seconds" },
        { path: "src/cache-key.mjs", text: "return parts.join('|')" },
      ],
      evidence: [
        { kind: "runtime", source: "unit-suite", text: "cache-ttl.test.mjs: expected TTL 300 (seconds), got 300000 (milliseconds) for session key" },
      ],
      unresolvedQuestions: ["Could also be a cache-key collision; the evidence must decide."],
    },
    knownFiles: ["src/cache-ttl.mjs", "src/cache-key.mjs"],
    expected: { deepseekCalled: true, verifier: "accepted", advisorCorrect: true },
  },
  {
    id: "case-3-easy-grounded",
    name: "Easy grounded task (AUTO must skip)",
    mode: WEB_ESCALATION_MODE.AUTO,
    autoExpected: "skip",
    escalateInput: { localConfidence: 0.95, affectedSubsystems: 1, verifierRetries: 0 },
    groundTruth: {
      diagnosis: "missing-semicolon",
      files: ["src/parse-config.mjs"],
      token: null,
      sourceMarker: "ground-truth-diagnosis: missing-semicolon",
      evidenceSummary: "trivial syntax fix, one file, local evidence only",
    },
    packetInput: {
      originalTask: "Fix the missing semicolon in src/parse-config.mjs.",
      requirements: ["Keep the parser behaviour identical"],
      constraints: ["MUST NOT change behaviour"],
      verification: ["Unit suite covers parse-config"],
      repoMap: { modules: ["src/parse-config.mjs"] },
      subsystems: ["config"],
      relevantFiles: [{ path: "src/parse-config.mjs", role: "target", score: 1 }],
      evidence: [
        { kind: "static", source: "syntax-check", text: "src/parse-config.mjs: missing semicolon at end of statement" },
      ],
    },
    knownFiles: ["src/parse-config.mjs"],
    expected: { deepseekCalled: false, verifier: "not-run", advisorCorrect: "n/a-skipped" },
  },
  {
    id: "case-4-hard-multi-subsystem",
    name: "Hard multi-subsystem task (AUTO must escalate)",
    mode: WEB_ESCALATION_MODE.AUTO,
    autoExpected: "escalate",
    escalateInput: { localConfidence: 0.3, affectedSubsystems: 3, verifierRetries: 2 },
    groundTruth: {
      diagnosis: "session-lease-expiry-race",
      files: ["src/api/session-router.mjs", "src/store/session-store.mjs", "src/ui/session-badge.mjs"],
      token: "session-lease-expiry-race",
      sourceMarker: "ground-truth-diagnosis: session-lease-expiry-race",
      evidenceSummary: "api 401 while store holds a live lease and ui renders a stale badge",
    },
    packetInput: {
      originalTask: "Multi-subsystem change: session expiry handling spans the api, store and ui layers.",
      requirements: ["One expiry authority shared by api, store and ui"],
      constraints: ["MUST NOT weaken the verifier", "MUST NOT fail open on lease expiry"],
      verification: ["Unit suite covers api, store and ui lease boundaries"],
      repoMap: { modules: ["src/api/session-router.mjs", "src/store/session-store.mjs", "src/ui/session-badge.mjs"] },
      subsystems: ["api", "store", "ui"],
      relevantFiles: [
        { path: "src/api/session-router.mjs", role: "target", score: 0.92 },
        { path: "src/store/session-store.mjs", role: "target", score: 0.9 },
        { path: "src/ui/session-badge.mjs", role: "target", score: 0.85 },
      ],
      dependencyGraph: ["api -> store", "ui -> store"],
      evidence: [
        { kind: "runtime", source: "integration-suite", text: "session-expiry: api returned 401 while store held a live lease; ui rendered stale badge" },
      ],
    },
    knownFiles: ["src/api/session-router.mjs", "src/store/session-store.mjs", "src/ui/session-badge.mjs"],
    expected: { deepseekCalled: true, verifier: "accepted", advisorCorrect: true },
  },
  {
    id: "case-5-wrong-advisor-output",
    name: "Intentionally wrong advisor output",
    mode: WEB_ESCALATION_MODE.AUTO,
    autoExpected: "escalate",
    escalateInput: { localConfidence: 0.35, affectedSubsystems: 1, verifierRetries: 2 },
    groundTruth: {
      diagnosis: "double-increment-on-rehydrate",
      files: ["src/counter-store.mjs"],
      token: "double-increment-on-rehydrate",
      sourceMarker: "ground-truth-diagnosis: double-increment-on-rehydrate",
      evidenceSummary: "rehydrate applies the event count twice (src/counter-store.mjs)",
    },
    packetInput: {
      originalTask: "Ambiguous root cause of the double increment; several possible fixes exist.",
      requirements: ["Name the cause the local evidence supports"],
      constraints: ["MUST NOT guess without evidence"],
      verification: ["Unit suite covers rehydrate"],
      repoMap: { modules: ["src/counter-store.mjs"] },
      subsystems: ["counter"],
      relevantFiles: [{ path: "src/counter-store.mjs", role: "target", score: 0.9 }],
      evidence: [
        { kind: "runtime", source: "unit-suite", text: "counter-rehydrate.test.mjs: expected count 1, got 2 after rehydrate (src/counter-store.mjs:2)" },
      ],
    },
    knownFiles: ["src/counter-store.mjs"],
    expected: { deepseekCalled: true, verifier: "rejected", advisorCorrect: false },
  },
  {
    id: "case-6-corrective-follow-up",
    name: "Corrective follow-up",
    mode: WEB_ESCALATION_MODE.AUTO,
    autoExpected: "escalate",
    escalateInput: { localConfidence: 0.3, affectedSubsystems: 1, verifierRetries: 3 },
    groundTruth: {
      diagnosis: "lock-ttl-never-refreshed",
      files: ["src/lock-ttl.mjs"],
      token: "lock-ttl-never-refreshed",
      sourceMarker: "ground-truth-diagnosis: lock-ttl-never-refreshed",
      evidenceSummary: "held lock lapses at t+0 despite ttl=300000 (src/lock-ttl.mjs)",
    },
    packetInput: {
      originalTask: "Verifier still fails after the first fix: the held lock still lapses early.",
      requirements: ["Explain the early lock expiry from local evidence"],
      constraints: ["MUST NOT weaken the verifier"],
      verification: ["Unit suite covers lock ttl refresh"],
      repoMap: { modules: ["src/lock-ttl.mjs"] },
      subsystems: ["lock"],
      relevantFiles: [{ path: "src/lock-ttl.mjs", role: "target", score: 0.93 }],
      evidence: [
        { kind: "runtime", source: "unit-suite", text: "lock-ttl.test.mjs: held lock released at t+0 despite ttl=300000 (src/lock-ttl.mjs:12)" },
      ],
      previousAttempts: ["Attempt 1: clamped the ttl in the cache layer. Verifier still fails."],
    },
    knownFiles: ["src/lock-ttl.mjs"],
    expected: { deepseekCalled: true, verifier: "accepted-after-follow-up", advisorCorrect: true },
  },
]

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

function makeCounters() {
  return { capability: 0, startSession: 0, consult: 0, followUp: 0, closeSession: 0 }
}

function makeAdapter(spec, counters) {
  return {
    id: PROVIDER_ID,
    maxFollowUps: 4,
    async capability() {
      counters.capability += 1
      return { state: "ready", supportsFollowUp: true, sessionReusable: true, maxPacketChars: 60_000 }
    },
    async startSession(input = {}) {
      counters.startSession += 1
      return { sessionId: `ds-fixture-${spec.id}`, state: "ready", reused: Boolean(input.reuseSessionId) }
    },
    async consult(_session, packet, options = {}) {
      counters.consult += 1
      const answer = ADVISORS[spec.id].consult(packet, options)
      return { answer: typeof answer === "string" ? answer : JSON.stringify(answer) }
    },
    async followUp(_session, delta, options = {}) {
      counters.followUp += 1
      const answer = ADVISORS[spec.id].followUp(delta, options)
      return { answer: typeof answer === "string" ? answer : JSON.stringify(answer) }
    },
    async closeSession() {
      counters.closeSession += 1
      return true
    },
  }
}

// ---------------------------------------------------------------------------
// case execution
// ---------------------------------------------------------------------------

async function writeFixture(caseDir, spec) {
  await rm(caseDir, { recursive: true, force: true })
  await mkdir(caseDir, { recursive: true })
  for (const [relative, content] of Object.entries(FIXTURES[spec.id] || {})) {
    const target = path.join(caseDir, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
}

async function runCase(spec) {
  const caseDir = path.join(workDir, spec.id)
  await writeFixture(caseDir, spec)

  const counters = makeCounters()
  const registry = createWebReasoningRegistry([makeAdapter(spec, counters)])
  const telemetry = createWebReasoningTelemetry()
  const deps = { registry, telemetry }

  const task = spec.packetInput.originalTask
  const escalationInput = {
    task,
    notes: [],
    mode: WEB_ESCALATION_MODE.AUTO,
    ...spec.escalateInput,
  }
  // AUTO's decision is scored for every case, including the case whose actual
  // run is forced.
  const autoDecision = decideWebEscalation(escalationInput)

  const initialPacket = buildDecisionPacket(spec.packetInput, { provider: PROVIDER_ID })
  const consultationInput = {
    mode: spec.mode,
    provider: PROVIDER_ID,
    task,
    notes: [],
    packet: initialPacket,
    knownFiles: spec.knownFiles,
    ...spec.escalateInput,
    ...(spec.id === "case-6-corrective-follow-up" ? { keepSession: true } : {}),
  }

  const initial = await runWebConsultation(consultationInput, deps)

  const record = {
    id: spec.id,
    name: spec.name,
    expectedGroundTruth: {
      diagnosis: spec.groundTruth.diagnosis,
      files: spec.groundTruth.files,
      diagnosisToken: spec.groundTruth.token ?? null,
      nearMissAlternative: spec.groundTruth.nearMissToken ?? null,
      sourceMarker: spec.groundTruth.sourceMarker,
      localEvidence: spec.groundTruth.evidenceSummary,
      autoRouting: spec.autoExpected,
      expectedAdvisorCorrect: spec.expected.advisorCorrect,
      expectedVerifier: spec.expected.verifier,
      expectedDeepSeekCalled: spec.expected.deepseekCalled,
    },
    advisorKind: spec.id === "case-5-wrong-advisor-output"
      ? "deterministic-wrong-fixture"
      : "deterministic-evidence-reading-double",
    escalation: {
      runMode: spec.mode,
      escalate: initial.decision?.escalate ?? null,
      reason: initial.decision?.reason ?? null,
      signals: initial.decision?.signals ?? [],
      nonEscalationSignals: initial.decision?.nonEscalationSignals ?? [],
      autoDecision: {
        escalate: autoDecision.escalate,
        reason: autoDecision.reason,
        signals: autoDecision.signals,
        nonEscalationSignals: autoDecision.nonEscalationSignals,
      },
      autoExpected: spec.autoExpected,
      autoMatch: (autoDecision.escalate ? "escalate" : "skip") === spec.autoExpected,
    },
    deepseekCalled: counters.consult > 0,
    deepseekSkipped: counters.consult === 0,
    providerCalls: { ...counters },
    initialOutcome: initial.outcome,
    initialReason: initial.reason ?? null,
    records: [],
    falsePassHits: [],
  }

  // Snapshot AFTER the case has fully run: a follow-up consult happens later
  // and must not be reported as a provider call that never happened.
  const providerCalls = () => ({ ...counters })

  // ---- initial advice -----------------------------------------------------
  const initialConclusion = initial.advice
    ? {
      stage: "consult",
      summary: initial.advice.summary,
      primaryHypothesis: (initial.advice.hypotheses || [])[0] ?? null,
      files: (initial.advice.filesToInspect || []).map(norm),
      confidence: initial.advice.confidence ?? null,
      score: evaluateAdvice(initial.advice, spec.groundTruth),
      verification: initial.verification
        ? {
          accepted: initial.verification.accepted,
          actionAuthorized: initial.verification.actionAuthorized,
          rejectionReasons: rejectionSummary(initial.verification),
          confirmations: (initial.verification.confirmations || []).map((row) => row.path),
          canProducePass: initial.verification.canProducePass,
          isTaskVerdict: initial.verification.isTaskVerdict,
        }
        : null,
    }
    : null

  record.records.push(initialConclusion)
  record.falsePassHits.push(...findFalsePass(initial, `${spec.id}.consult`))

  // ---- corrective follow-up (case 6) --------------------------------------
  let followUp = null
  let finalAdvice = initial.advice || null
  let finalVerification = initial.verification || null

  if (spec.id === "case-6-corrective-follow-up") {
    const verifierFeedback = initial.verification
      ? rejectionSummary(initial.verification) || "advice-accepted"
      : "no-verification"
    const followUpPacketInput = {
      ...spec.packetInput,
      evidence: [
        ...(spec.packetInput.evidence || []),
        {
          kind: "verifier",
          source: "local-advice-verification",
          text: `advice rejected: ${verifierFeedback} for src/lock-ttl-cache.mjs`,
        },
      ],
      previousAttempts: [
        ...(spec.packetInput.previousAttempts || []),
        `Attempt 1 (local verification rejected): ${verifierFeedback} for src/lock-ttl-cache.mjs`,
      ],
    }
    const nextPacket = buildDecisionPacket(followUpPacketInput, { provider: PROVIDER_ID })
    const delta = buildFollowUpDelta(initialPacket, nextPacket)

    followUp = await runWebFollowUp({
      ...consultationInput,
      previousPacket: initialPacket,
      nextPacket,
      session: initial._session,
      attempt: 1,
      maxFollowUps: 2,
    }, deps)

    finalAdvice = followUp.advice || finalAdvice
    finalVerification = followUp.verification || finalVerification

    record.followUp = {
      called: counters.followUp > 0,
      followedUp: followUp.followedUp === true,
      sameSession: Boolean(followUp.sessionId) && followUp.sessionId === initial.sessionId,
      delta: {
        changed: delta.changed,
        changedSections: delta.changedSections,
        unchangedSections: delta.unchangedSections,
        deltaChars: delta.chars,
        fullPacketChars: initialPacket.chars,
        bounded: delta.changed === true
          && delta.chars > 0
          && delta.chars < Number(initialPacket.chars || 0)
          && delta.changedSections.length <= 4,
        resentFullPacket: delta.chars >= Number(initialPacket.chars || 0),
      },
      outcome: followUp.outcome,
      reason: followUp.reason ?? null,
      improvement: initialConclusion && finalAdvice
        ? {
          initialCorrect: evaluateAdvice(initial.advice, spec.groundTruth).correct,
          followUpCorrect: evaluateAdvice(finalAdvice, spec.groundTruth).correct,
        }
        : null,
    }
    record.records.push({
      stage: "follow-up",
      summary: finalAdvice?.summary ?? null,
      primaryHypothesis: (finalAdvice?.hypotheses || [])[0] ?? null,
      files: (finalAdvice?.filesToInspect || []).map(norm),
      confidence: finalAdvice?.confidence ?? null,
      score: evaluateAdvice(finalAdvice, spec.groundTruth),
      verification: followUp.verification
        ? {
          accepted: followUp.verification.accepted,
          actionAuthorized: followUp.verification.actionAuthorized,
          rejectionReasons: rejectionSummary(followUp.verification),
          confirmations: (followUp.verification.confirmations || []).map((row) => row.path),
          canProducePass: followUp.verification.canProducePass,
          isTaskVerdict: followUp.verification.isTaskVerdict,
        }
        : null,
    })
    record.falsePassHits.push(...findFalsePass(followUp, `${spec.id}.followUp`))
    if (initial._session) {
      try {
        await registry.get(PROVIDER_ID).closeSession(initial._session)
      } catch {
        // close failures must not mask the outcome
      }
    }
  }

  // ---- scoring ------------------------------------------------------------
  const finalScore = finalAdvice ? evaluateAdvice(finalAdvice, spec.groundTruth) : null
  const advisorCorrect = finalScore
    ? finalScore.correct
    : spec.expected.advisorCorrect === "n/a-skipped" ? "n/a-skipped" : null
  const evidence = await sourceEvidenceSupports(caseDir, spec.groundTruth)

  const accepted = finalVerification ? finalVerification.accepted === true : null
  const verdictObject = initial.consulted === true ? initial : followUp
  const canProducePass = verdictObject ? verdictObject.canProducePass === true : false

  const falseAcceptance = accepted === true && advisorCorrect === false

  record.deepseekCalled = counters.consult > 0
  record.advisorConclusion = finalAdvice
    ? {
      summary: finalAdvice.summary,
      primaryHypothesis: (finalAdvice.hypotheses || [])[0] ?? null,
      files: (finalAdvice.filesToInspect || []).map(norm),
      confidence: finalAdvice.confidence ?? null,
    }
    : "n/a (AUTO skipped DeepSeek for this task)"
  record.advisorCorrect = advisorCorrect
  record.verifier = finalVerification
    ? {
      result: accepted ? "accepted" : "rejected",
      actionAuthorized: finalVerification.actionAuthorized,
      rejectionReasons: rejectionSummary(finalVerification),
      confirmations: (finalVerification.confirmations || []).map((row) => row.path),
      canProducePass: finalVerification.canProducePass,
      isTaskVerdict: finalVerification.isTaskVerdict,
    }
    : { result: "not-run", actionAuthorized: null, canProducePass: false, isTaskVerdict: false }
  record.canProducePass = canProducePass || record.verifier.canProducePass === true
  record.sourceEvidence = evidence
  record.falseAcceptance = falseAcceptance
  record.finalLocalVerifierResult = finalVerification
    ? `${accepted ? "ACCEPTED" : "REJECTED"}${rejectionSummary(finalVerification) ? ` (${rejectionSummary(finalVerification)})` : ""} | actionAuthorized=${finalVerification.actionAuthorized} | canProducePass=${finalVerification.canProducePass} | isTaskVerdict=${finalVerification.isTaskVerdict}`
    : "NOT RUN (no advice: AUTO skipped DeepSeek)"
  record.telemetry = telemetry.snapshot()
  record.providerCalls = providerCalls()

  // per-case expectation checks (reported, not gating by themselves)
  const firstStageAccepted = record.records[0]?.verification?.accepted ?? null
  const verifierMatches = (() => {
    const expected = spec.expected.verifier
    if (expected === "not-run") return record.verifier.result === "not-run"
    if (expected === "accepted") return record.verifier.result === "accepted"
    if (expected === "rejected") return record.verifier.result === "rejected"
    if (expected === "accepted-after-follow-up") {
      return firstStageAccepted === false && record.verifier.result === "accepted"
    }
    return false
  })()
  record.expectations = {
    deepseekCalledMatches: record.deepseekCalled === spec.expected.deepseekCalled,
    verifierMatches,
    advisorCorrectMatches: advisorCorrect === spec.expected.advisorCorrect,
    autoRoutingMatches: record.escalation.autoMatch,
  }

  return record
}

// ---------------------------------------------------------------------------
// local tests
// ---------------------------------------------------------------------------

async function runLocalTests() {
  if (skipLocalTests) {
    return { ran: false, reason: "--skip-local-tests", pass: false, exitCode: null, files: null, passCount: null, failCount: null, durationMs: 0 }
  }
  const startedAt = Date.now()
  const child = spawn(process.execPath, ["scripts/run-test-suite.mjs"], { cwd: root, env: { ...process.env } })
  let out = ""
  let err = ""
  child.stdout.on("data", (chunk) => { out = `${out}${chunk}`.slice(-400_000) })
  child.stderr.on("data", (chunk) => { err = `${err}${chunk}`.slice(-200_000) })
  const exitCode = await new Promise((resolve) => child.on("close", resolve))
  const grab = (pattern) => {
    const match = out.match(pattern)
    return match ? Number(match[1]) : null
  }
  const files = grab(/^files: (\d+)$/m)
  const passCount = grab(/^pass: (\d+)$/m)
  const failCount = grab(/^fail: (\d+)$/m)
  const failed = failCount === null || failCount > 0 || exitCode !== 0
  return {
    ran: true,
    command: "node scripts/run-test-suite.mjs",
    exitCode,
    files,
    passCount,
    failCount,
    durationMs: Date.now() - startedAt,
    pass: !failed,
    tail: failed ? `${out.slice(-4_000)}\n${err.slice(-4_000)}` : undefined,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })
clearDecisionPacketCache()

const results = []
for (const spec of CASES) results.push(await runCase(spec))

// ---- aggregates -----------------------------------------------------------
const wrongAdvice = []
for (const row of results) {
  for (const entry of row.records) {
    if (!entry || !entry.verification) continue
    if (entry.score && entry.score.correct === false) {
      wrongAdvice.push({
        case: row.id,
        stage: entry.stage,
        accepted: entry.verification.accepted,
        rejectionReasons: entry.verification.rejectionReasons,
      })
    }
  }
}
const rejectedWrong = wrongAdvice.filter((row) => row.accepted === false)
const falseAcceptedAdvice = wrongAdvice.filter((row) => row.accepted === true)

const concluded = results.filter((row) => row.advisorCorrect === true || row.advisorCorrect === false)
const correctConcluded = concluded.filter((row) => row.advisorCorrect === true)
const accuracyCases = concluded.filter((row) => row.id !== "case-5-wrong-advisor-output")

const falsePassHits = results.flatMap((row) => row.falsePassHits)
const autoMatches = results.filter((row) => row.escalation.autoMatch)
const trivial = results.find((row) => row.id === "case-3-easy-grounded")
const hard = results.find((row) => row.id === "case-4-hard-multi-subsystem")
const wrongCase = results.find((row) => row.id === "case-5-wrong-advisor-output")

const localTests = await runLocalTests()

const wrongAdviceRejectedAll = wrongAdvice.length > 0 && rejectedWrong.length === wrongAdvice.length
const trivialSkipped = trivial && trivial.deepseekCalled === false && trivial.escalation.autoMatch === true
const hardEscalated = hard && hard.deepseekCalled === true && hard.escalation.autoMatch === true
const wrongRejected = wrongCase && wrongCase.verifier.result === "rejected" && wrongCase.canProducePass === false

const verdictChecks = {
  falseAcceptedAdviceIsZero: falseAcceptedAdvice.length === 0,
  falsePassIsZero: falsePassHits.length === 0,
  intentionallyWrongAdviceRejected: Boolean(wrongRejected),
  allWrongAdviceRejected: wrongAdviceRejectedAll,
  trivialTaskSkipped: Boolean(trivialSkipped),
  hardTaskEscalated: Boolean(hardEscalated),
  allLocalTestsPass: localTests.pass === true,
}
const packageReady = Object.values(verdictChecks).every(Boolean)

const report = {
  schemaVersion: 1,
  kind: "ues-v16-3-deepseek-accuracy-validation",
  generatedAt: new Date().toISOString(),
  scope: {
    providerKind: "deterministic-local-fixtures",
    liveDeepSeek: false,
    networkUsed: false,
    browserUsed: false,
    uesRunUsed: false,
    verifierPolicyChanged: false,
    publishPushOrVersionBump: false,
  },
  cases: results.map((row) => ({
    id: row.id,
    name: row.name,
    expectedGroundTruth: row.expectedGroundTruth,
    advisorKind: row.advisorKind,
    escalationDecision: {
      runMode: row.escalation.runMode,
      escalate: row.escalation.escalate,
      reason: row.escalation.reason,
      signals: row.escalation.signals,
      nonEscalationSignals: row.escalation.nonEscalationSignals,
    },
    autoDecision: row.escalation.autoDecision,
    autoExpected: row.escalation.autoExpected,
    autoRoutingMatch: row.escalation.autoMatch,
    deepseekCalled: row.deepseekCalled,
    deepseekSkipped: row.deepseekSkipped,
    providerCalls: row.providerCalls,
    advisorConclusion: row.advisorConclusion,
    advisorCorrect: row.advisorCorrect,
    verifierAccepted: row.verifier.result,
    verifierDetail: row.verifier,
    canProducePass: row.canProducePass,
    falseAcceptance: row.falseAcceptance ? "yes" : "no",
    sourceEvidenceSupports: row.sourceEvidence.supported,
    followUp: row.followUp ?? null,
    finalLocalVerifierResult: row.finalLocalVerifierResult,
    expectations: row.expectations,
    falsePassHits: row.falsePassHits,
  })),
  aggregate: {
    advisorCorrectnessRate: concluded.length
      ? {
        correct: correctConcluded.length,
        concluded: concluded.length,
        rate: Number((correctConcluded.length / concluded.length).toFixed(3)),
        note: "all advisor conclusions, including the intentionally injected wrong one (case 5)",
      }
      : null,
    advisorCorrectnessRateAccuracyCases: accuracyCases.length
      ? {
        correct: accuracyCases.filter((row) => row.advisorCorrect === true).length,
        concluded: accuracyCases.length,
        rate: Number((accuracyCases.filter((row) => row.advisorCorrect === true).length / accuracyCases.length).toFixed(3)),
        note: "excludes the deliberately wrong case 5",
      }
      : null,
    verifierRejectionRateWrongAdvice: wrongAdvice.length
      ? {
        rejected: rejectedWrong.length,
        wrongAdvice: wrongAdvice.length,
        rate: Number((rejectedWrong.length / wrongAdvice.length).toFixed(3)),
        instances: wrongAdvice,
      }
      : { rejected: 0, wrongAdvice: 0, rate: null, instances: [] },
    falseAcceptedAdviceCount: falseAcceptedAdvice.length,
    falseAcceptedAdvice: falseAcceptedAdvice,
    falsePassCount: falsePassHits.length,
    falsePassHits,
    autoRoutingAccuracy: {
      matched: autoMatches.length,
      total: results.length,
      rate: Number((autoMatches.length / results.length).toFixed(3)),
      rows: results.map((row) => ({
        case: row.id,
        expected: row.escalation.autoExpected,
        actual: row.escalation.autoDecision.escalate ? "escalate" : "skip",
        match: row.escalation.autoMatch,
        runMode: row.escalation.runMode,
      })),
    },
    localTests,
    verdictChecks,
  },
  verdict: { PACKAGE_READY: packageReady },
}

const reportPath = path.join(workDir, "report.json")
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

// ---- console report -------------------------------------------------------
const line = (text = "") => console.log(text)
line("V16.3 DeepSeek accuracy validation — synthetic/local fixtures only")
line("=".repeat(112))
for (const row of report.cases) {
  line(`\n[${row.id}] ${row.name}`)
  line(`  ground truth        : ${row.expectedGroundTruth.diagnosis} in ${row.expectedGroundTruth.files.join(", ")}`)
  line(`  escalation decision : mode=${row.escalationDecision.runMode} escalate=${row.escalationDecision.escalate} reason=${row.escalationDecision.reason}${row.escalationDecision.signals.length ? ` signals=${row.escalationDecision.signals.join(",")}` : ""}`)
  line(`  AUTO decision       : ${row.autoDecision.escalate ? "escalate" : "skip"} (expected ${row.autoExpected}) match=${row.autoRoutingMatch}`)
  line(`  DeepSeek            : ${row.deepseekCalled ? "CALLED" : "SKIPPED"} (consult=${row.providerCalls.consult} followUp=${row.providerCalls.followUp})`)
  line(`  advisor conclusion  : ${typeof row.advisorConclusion === "string" ? row.advisorConclusion : `"${row.advisorConclusion.summary}" (conf ${row.advisorConclusion.confidence}, files ${row.advisorConclusion.files.join(", ") || "-"})`}`)
  line(`  advisor correct     : ${row.advisorCorrect === "n/a-skipped" ? "n/a (skipped)" : row.advisorCorrect ? "CORRECT" : "INCORRECT"}`)
  line(`  verifier            : ${row.verifierAccepted}${row.verifierDetail.rejectionReasons ? ` (${row.verifierDetail.rejectionReasons})` : ""}`)
  line(`  canProducePass      : ${row.canProducePass}`)
  line(`  false acceptance    : ${row.falseAcceptance}`)
  line(`  source evidence     : ${row.sourceEvidenceSupports ? "supports" : "DOES NOT SUPPORT"}`)
  if (row.followUp) {
    line(`  follow-up           : called=${row.followUp.called} sameSession=${row.followUp.sameSession} delta=${row.followUp.delta.deltaChars}ch/${row.followUp.delta.changedSections.length} sections (full packet ${row.followUp.delta.fullPacketChars}ch) bounded=${row.followUp.delta.bounded} resentFullPacket=${row.followUp.delta.resentFullPacket}`)
    line(`  follow-up improve   : initialCorrect=${row.followUp.improvement?.initialCorrect} -> followUpCorrect=${row.followUp.improvement?.followUpCorrect}`)
  }
  line(`  final local verify  : ${row.finalLocalVerifierResult}`)
}
line("\n" + "=".repeat(112))
const agg = report.aggregate
const pct = (value) => (value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`)
line(`advisor correctness rate            : ${agg.advisorCorrectnessRate ? `${agg.advisorCorrectnessRate.correct}/${agg.advisorCorrectnessRate.concluded} = ${pct(agg.advisorCorrectnessRate.rate)}` : "n/a"}  (${agg.advisorCorrectnessRate?.note})`)
line(`advisor correctness (accuracy only) : ${agg.advisorCorrectnessRateAccuracyCases ? `${agg.advisorCorrectnessRateAccuracyCases.correct}/${agg.advisorCorrectnessRateAccuracyCases.concluded} = ${pct(agg.advisorCorrectnessRateAccuracyCases.rate)}` : "n/a"}`)
line(`verifier rejection rate (wrong adv) : ${agg.verifierRejectionRateWrongAdvice.wrongAdvice ? `${agg.verifierRejectionRateWrongAdvice.rejected}/${agg.verifierRejectionRateWrongAdvice.wrongAdvice} = ${pct(agg.verifierRejectionRateWrongAdvice.rate)}` : "n/a"}`)
line(`false accepted advice count         : ${agg.falseAcceptedAdviceCount}`)
line(`false PASS count                    : ${agg.falsePassCount}`)
line(`AUTO routing accuracy               : ${agg.autoRoutingAccuracy.matched}/${agg.autoRoutingAccuracy.total} = ${pct(agg.autoRoutingAccuracy.rate)}`)
line(`local tests                         : ${agg.localTests.ran ? `${agg.localTests.passCount}/${agg.localTests.files} pass, fail=${agg.localTests.failCount}, exit=${agg.localTests.exitCode}, ${agg.localTests.durationMs}ms` : `SKIPPED (${agg.localTests.reason})`}`)
line("verdict checks:")
for (const [name, value] of Object.entries(agg.verdictChecks)) line(`  - ${name}: ${value ? "PASS" : "FAIL"}`)
line(`\nPACKAGE_READY: ${packageReady ? "true" : "false"}`)
line(`report: ${path.relative(root, reportPath).replaceAll("\\", "/")}`)

process.exitCode = packageReady ? 0 : 1
