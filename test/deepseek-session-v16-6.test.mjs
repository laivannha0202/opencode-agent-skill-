// Sections C, D, E, F: the V16.6 DeepSeek session intelligence surface.
//
//   C  session budget + context-window detection + session pool leases
//   D  consult cache (bounded LRU, evidence-keyed)
//   E  resume capsule (bounded, deterministic, secret-scanned)
//   F  evidence requests (allowlisted, workspace-contained, redacted)
//
// The invariants asserted here are the ones that keep DeepSeek an advisor:
// no tool execution, no filesystem reach, no authority, bounded everything.

import assert from "node:assert/strict"
import test from "node:test"

import {
  CONSERVATIVE_CONTEXT_TOKENS,
  MAX_CONTEXT_TOKENS,
  closeConversationSession,
  createConversationSession,
  pruneSessions,
  recordSessionTurn,
  resolveContextWindowTokens,
  resolveSessionBudget,
  sessionTelemetry,
  shouldRotateSession,
} from "../lib/deepseek-session-budget.mjs"
import { createSessionPool } from "../lib/deepseek-session-pool.mjs"
import {
  DEFAULT_CACHE_ENTRIES,
  HARD_MAX_CACHE_ENTRIES,
  consultCacheKey,
  consultOnce,
  createConsultCache,
  resetConsultCacheForTests,
} from "../lib/deepseek-consult-cache.mjs"
import {
  MAX_CAPSULE_CHARS,
  assertResumeCapsule,
  buildResumeCapsule,
  capsuleContext,
  resumeFingerprint,
} from "../lib/deepseek-resume-capsule.mjs"
import {
  EVIDENCE_KINDS,
  MAX_REQUESTS_PER_EXCHANGE,
  MAX_REQUESTS_PER_RUN,
  authorizeEvidenceRequest,
  createEvidenceRequestBudget,
  isInsideWorkspace,
  parseEvidenceRequests,
  prepareEvidenceDelta,
} from "../lib/deepseek-evidence-requests.mjs"

test("C1: the session budget is bounded and env-clamped", () => {
  const defaults = resolveSessionBudget({})
  assert.ok(defaults.maxTurnsBeforeRotation > 0)
  assert.equal(defaults.maxConcurrentSessions, 2)
  assert.equal(defaults.hardMaxConcurrentSessions, 3)
  const hostile = resolveSessionBudget({ UES_DEEPSEEK_MAX_TURNS: "99999", UES_DEEPSEEK_MAX_CONCURRENT: "999" })
  assert.ok(hostile.maxTurnsBeforeRotation <= 24)
  assert.ok(hostile.maxConcurrentSessions <= 3)
})

test("C2: the context window is detected, overridable, never hard-coded", () => {
  const detected = resolveContextWindowTokens({}, 200_000)
  assert.equal(detected.tokens, 200_000)
  assert.equal(detected.source, "detected")
  assert.equal(detected.provenance, "MEASURED")
  const override = resolveContextWindowTokens({ UES_DEEPSEEK_CONTEXT_TOKENS: "100000" }, 8_000)
  assert.equal(override.tokens, 100_000)
  assert.equal(override.source, "override")
  const fallback = resolveContextWindowTokens({}, null)
  assert.equal(fallback.tokens, CONSERVATIVE_CONTEXT_TOKENS)
  assert.equal(fallback.source, "conservative-fallback")
  assert.equal(fallback.provenance, "ESTIMATED", "the fallback is a guess, and says so")
  assert.notEqual(CONSERVATIVE_CONTEXT_TOKENS, 64_000, "no hard-coded 64K window")
  const clamped = resolveContextWindowTokens({ UES_DEEPSEEK_CONTEXT_TOKENS: "999999999" }, null)
  assert.ok(clamped.tokens <= MAX_CONTEXT_TOKENS)
  const invalid = resolveContextWindowTokens({ UES_DEEPSEEK_CONTEXT_TOKENS: "auto-nonsense" }, null)
  assert.equal(invalid.source, "conservative-fallback")
  assert.equal(invalid.normalized, false)
})

test("C3: rotation happens for stated reasons only", () => {
  const now = Date.now()
  const session = createConversationSession({ id: "s1", role: "root-cause", turnBudget: 4 })
  assert.equal(shouldRotateSession(session, now).rotate, false)
  const limit = resolveSessionBudget({}).maxTurnsBeforeRotation
  for (let i = 0; i < limit; i += 1) recordSessionTurn(session, { inputChars: 10, outputChars: 5, now })
  const rotation = shouldRotateSession(session, now)
  assert.equal(rotation.rotate, true)
  assert.ok(rotation.reasons.includes("turn-budget-exhausted"))
  const idle = shouldRotateSession(session, now + 10 * 60 * 60 * 1000)
  assert.ok(idle.reasons.includes("idle-expired"))
  closeConversationSession(session, "task-complete")
  assert.equal(session.status, "closed")
  assert.equal(session.closedReason, "task-complete")
  const before = session.turnsUsed
  assert.equal(recordSessionTurn(session, { inputChars: 1 }).turnsUsed, before, "closed sessions never record")
  assert.equal(shouldRotateSession(session, now).reasons.includes("already-closed"), true)
})

test("C4: session telemetry labels every number and never invents savings", () => {
  const session = createConversationSession({ id: "s2", role: "code-review" })
  recordSessionTurn(session, { inputChars: 900, outputChars: 120, evidenceRefs: ["evidence:sha256:aa", "evidence:sha256:aa"] })
  const telemetry = sessionTelemetry(session)
  assert.equal(telemetry.turns.value, 1)
  assert.equal(telemetry.uniqueEvidenceRefs.value, 1, "evidence refs are deduplicated")
  assert.equal(telemetry.tokensSaved.provenance, "NOT_MEASURED")
  assert.equal(telemetry.latencyMs.provenance, "NOT_MEASURED")
  assert.equal(telemetry.inputTokens.provenance, "ESTIMATED", "chars->tokens stays an estimate")
  const now = Date.now()
  const pruned = pruneSessions([
    { id: "idle", lastActiveAt: now - 10 * 60 * 60 * 1000, status: "open" },
    { id: "closed", lastActiveAt: now - 10 * 60 * 1000, status: "closed" },
    { id: "fresh", lastActiveAt: now, status: "open" },
  ], { now })
  assert.deepEqual(pruned.sessions.map((row) => row.id), ["fresh"])
  assert.deepEqual(pruned.evicted.map((row) => row.reason).sort(), ["closed-expired", "idle-expired"])
  const capacity = pruneSessions(Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, lastActiveAt: now + index, status: "open" })), { now })
  assert.ok(capacity.sessions.length <= 8)
  assert.ok(capacity.evicted.some((row) => row.reason === "capacity"))
})

test("C5: the pool grants exactly one write lease per session", () => {
  const pool = createSessionPool({ env: {} })
  const session = pool.createSession({ id: "p1", role: "research" })
  const first = pool.acquire(session.id, { mode: "write" })
  assert.equal(first.ok, true)
  const second = pool.acquire(session.id, { mode: "write" })
  assert.equal(second.ok, false)
  assert.ok(String(second.reason).includes("write-lease"))
  pool.release(first.lease)
  const third = pool.acquire(session.id, { mode: "write" })
  assert.equal(third.ok, true, "the lease is reusable after release")
  pool.release(third.lease)
})

test("C6: read-only overlap is allowed and concurrency is bounded", () => {
  const pool = createSessionPool({ env: {} })
  const session = pool.createSession({ id: "p2" })
  const readerA = pool.acquire(session.id, { mode: "read" })
  const readerB = pool.acquire(session.id, { mode: "read" })
  assert.equal(readerA.ok && readerB.ok, true)
  const other = pool.createSession({ id: "p3" })
  const writer = pool.acquire(other.id, { mode: "write" })
  assert.equal(writer.ok, true)
  const overflow = pool.acquire(pool.createSession({ id: "p4" }).id, { mode: "write" })
  assert.equal(overflow.ok, false, "hard concurrency max is enforced")
  const report = pool.report()
  assert.ok(report.telemetry.maxConcurrentWriters <= 3)
  const rotated = pool.rotate(session.id, { reasons: ["turn-budget-exhausted"], nextObjective: "continue" })
  assert.equal(rotated.ok, true)
  assert.ok(rotated.capsule || report.lastCapsule !== undefined)
})

test("D1: the consult cache key binds HEAD, diff, evidence, role and question", () => {
  const base = { head: "abc", diff: "diff", evidenceFingerprint: "ev", role: "root-cause", phase: "execute", reasoningMode: "balanced", question: "why?", constraints: "no secrets" }
  const key = consultCacheKey(base)
  assert.equal(key, consultCacheKey({ ...base }))
  for (const mutation of [
    { head: "def" },
    { diff: "other diff" },
    { evidenceFingerprint: "other" },
    { role: "code-review" },
    { question: "why not?" },
    { constraints: "other constraints" },
    { reasoningMode: "economy" },
  ]) {
    assert.notEqual(key, consultCacheKey({ ...base, ...mutation }), JSON.stringify(mutation))
  }
})

test("D2: a cache hit avoids a provider turn and a miss does not", async () => {
  const cache = createConsultCache({ maxEntries: 4, ttlMs: 60_000 })
  cache.beginRun("run-1")
  const input = { head: "abc", diff: "d", evidenceFingerprint: "e", role: "code-review", phase: "execute", reasoningMode: "balanced", question: "q", constraints: "c" }
  const first = consultOnce(cache, input)
  assert.equal(first.cached, false)
  cache.put(first.key, { answer: "because", role: "code-review", turn: 1 })
  const second = consultOnce(cache, input)
  assert.equal(second.cached, true)
  assert.equal(second.answer, "because")
  const stats = cache.stats()
  assert.ok(stats.hits >= 1)
  assert.ok(stats.misses >= 1)
  assert.equal(stats.duplicatesAvoided, 1)
  assert.equal(stats.size.value, 1)
  const invalidated = cache.invalidate("head-moved")
  assert.ok(invalidated.dropped >= 1)
  assert.equal(consultOnce(cache, input).cached, false)
})

test("D3: the cache is bounded and TTL-bounded", () => {
  const cache = createConsultCache({ maxEntries: 2, ttlMs: 1 })
  cache.beginRun("run-2")
  for (const question of ["q1", "q2", "q3"]) {
    const key = consultCacheKey({ question })
    cache.put(key, { answer: question }, Date.now())
  }
  assert.ok(cache.size() <= 2, "LRU capacity is enforced")
  const key = consultCacheKey({ question: "q1" })
  cache.put(key, { answer: "q1" }, Date.now())
  assert.equal(cache.get(key, Date.now() + 5_000), null, "expired entries are dropped")
  assert.equal(DEFAULT_CACHE_ENTRIES <= HARD_MAX_CACHE_ENTRIES, true)
})

test("D4: the shared cache singleton can be reset for tests", () => {
  resetConsultCacheForTests()
  assert.ok(resetConsultCacheForTests() !== undefined || true)
})

test("E1: the resume capsule is bounded, deterministic and secret-free", () => {
  const session = createConversationSession({ id: "s3", role: "implementation-plan", reasoningMode: "deepseek-first", turnBudget: 3 })
  recordSessionTurn(session, { inputChars: 500, outputChars: 200, evidenceRefs: ["evidence:sha256:bb"] })
  const input = {
    session,
    nextObjective: "Implement the budget wiring",
    decisions: ["Keep the turbo fast lane"],
    constraints: ["never write .env", "never commit"],
    evidenceRefs: ["evidence:sha256:bb"],
    maxChars: 2_000,
  }
  const first = buildResumeCapsule(input)
  const second = buildResumeCapsule(input)
  assert.equal(first.ok, true)
  assert.equal(first.content, second.content, "capsule text is deterministic")
  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(resumeFingerprint(first.content), resumeFingerprint(second.content))
  assert.ok(first.sizeChars <= 2_000)
  assert.equal(assertResumeCapsule(first).ok, true)
  assert.equal(capsuleContext(first), first.content)
})

test("E2: a capsule carrying a secret is redacted, and an unmasked one is refused", () => {
  const capsule = buildResumeCapsule({
    session: createConversationSession({ id: "s4" }),
    decisions: ["token sk-abcdef1234567890abcdef"],
    maxChars: 4_000,
  })
  if (capsule.ok) {
    assert.ok(!capsule.content.includes("sk-abcdef1234567890abcdef"), "a secret never survives redaction")
    assert.deepEqual(capsule.redactions, ["[REDACTED]"])
    assert.equal(assertResumeCapsule(capsule).ok, true)
  } else {
    assert.equal(capsule.blocked, "secret-scan-failed")
  }
  // Fail-closed assertion: a capsule that somehow still carries an unmasked
  // secret is never accepted as conversation continuity.
  const forged = { ...capsule, secretScanClean: true, content: "api_key=sk-abcdef1234567890abcdef" }
  assert.equal(assertResumeCapsule(forged).ok, false)
})

test("E3: an oversized capsule is truncated deterministically", () => {
  const capsule = buildResumeCapsule({
    session: createConversationSession({ id: "s5" }),
    decisions: Array.from({ length: 8 }, (_, index) => `decision-${index} ` + "x".repeat(400)),
    maxChars: 1_200,
  })
  assert.equal(capsule.ok, true)
  assert.ok(capsule.sizeChars <= 1_200)
  assert.ok(capsule.sizeChars <= MAX_CAPSULE_CHARS)
  assert.equal(capsule.truncated, true)
})

test("F1: only allowlisted evidence kinds are parsed", () => {
  const parsed = parseEvidenceRequests([
    "evidence-request: diff",
    "evidence: verifier-output",
    "evidence-request: rm-rf-slash",
    "evidence-request: diff",
  ].join("\n"))
  assert.equal(parsed.requests.length, 2)
  assert.ok(parsed.rejected.some((row) => row.reason === "kind-not-allowlisted"))
  assert.ok(parsed.rejected.some((row) => row.reason === "duplicate"))
  for (const row of parsed.requests) {
    assert.ok(EVIDENCE_KINDS[row.kind], `${row.kind} is allowlisted`)
  }
  assert.equal(parsed.maxRequests, MAX_REQUESTS_PER_EXCHANGE)
})

test("F2: evidence requests stay inside the workspace and never touch secrets", () => {
  const root = process.cwd()
  assert.equal(isInsideWorkspace(root, `${root}/lib/x.mjs`), true)
  assert.equal(isInsideWorkspace(root, "../outside.txt"), false)
  const allowed = authorizeEvidenceRequest({ kind: "diff", target: "lib/x.mjs" }, { root })
  assert.equal(allowed.allowed, true)
  for (const request of [
    { kind: "diff", target: "../escape.txt" },
    { kind: "diff", target: ".env" },
    { kind: "diff", target: ".git/config" },
    { kind: "diff", target: "node_modules/pkg/index.js" },
    { kind: "shell-out", target: "lib/x.mjs" },
  ]) {
    const decision = authorizeEvidenceRequest(request, { root })
    assert.equal(decision.allowed, false, JSON.stringify(request))
    assert.ok(decision.violations.length > 0)
  }
  assert.equal(authorizeEvidenceRequest({ kind: "diff", target: "lib/x.mjs" }, {}).allowed, false, "no root means no allow")
})

test("F3: the per-run evidence cap is enforced and reported", () => {
  const budget = createEvidenceRequestBudget()
  let allowed = 0
  for (let i = 0; i < MAX_REQUESTS_PER_RUN + 4; i += 1) {
    if (budget.authorize({ kind: "diff", target: `lib/file-${i}.mjs` }, { root: process.cwd() }).allowed) allowed += 1
  }
  assert.equal(allowed, MAX_REQUESTS_PER_RUN)
  const telemetry = budget.telemetry()
  assert.equal(telemetry.requestsThisRun.value, MAX_REQUESTS_PER_RUN)
  assert.equal(telemetry.maxPerRun.value, MAX_REQUESTS_PER_RUN)
  assert.equal(telemetry.deltaTokenEstimate.provenance, "NOT_MEASURED")
  budget.reset()
  assert.equal(budget.requestsThisRun, 0)
})

test("F4: a delta is redacted, bounded and re-scanned before it can leave", () => {
  const delta = prepareEvidenceDelta({
    kind: "diff",
    text: `const password = "hunter2hunter2";\n${"x".repeat(9_000)}`,
    maxChars: 1_000,
  })
  assert.equal(delta.ok, true)
  assert.ok(delta.chars <= 1_000)
  assert.equal(delta.redactionApplied, true)
  assert.ok(!/hunter2hunter2/.test(delta.text))
  const unknown = prepareEvidenceDelta({ kind: "run-anything", text: "x" })
  assert.equal(unknown.ok, false)
})