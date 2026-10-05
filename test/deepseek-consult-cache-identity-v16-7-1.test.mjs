// V16.7.1 Part 13: consultation cache identity + replay-vs-live distinction.
//
// A cache is only safe if its key is COMPLETE: two materially different
// consultations must never collide, and a cache replay must be distinguishable
// from a live provider answer at the caller. This file proves both:
//
//   - the key folds in the opaque PROFILE id, the TASK fingerprint, the
//     EVIDENCE digest, the REPO fingerprint and the SESSION identity, each in
//     its own bucket, so a change in any one of them forces a MISS;
//   - no raw path, prompt, payload or credential is recoverable from a key;
//   - the controller's `web-reasoning.consulted` event carries a `source`
//     discriminator that separates `cache-replay` from `provider`.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  CONSULT_CACHE_POLICY,
  CONSULT_CACHE_SCHEMA_VERSION,
  consultCacheKey,
  createConsultCache,
} from "../lib/deepseek-consult-cache.mjs"
import { profileIdFor } from "../lib/deepseek-profile-registry.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

const BASE = {
  workspaceId: "ws-1",
  head: "deadbeef",
  workspaceStateFingerprint: "state-fp",
  diff: "--- a/x\n+++ b/x\n+line",
  relevantFiles: [{ path: "lib/x.mjs", content: "one" }],
  evidenceFingerprint: "evidence-1",
  packetFingerprint: "packet-text",
  role: "root-cause",
  phase: "execute",
  reasoningMode: "balanced",
  question: "why does the verifier still fail",
  constraints: "MUST NOT disable verification",
  provider: "deepseek-web",
  model: "gpt-5",
  profileId: profileIdFor("personal"),
  taskFingerprint: "task-fp-1",
  repoFingerprint: "repo-fp-1",
  sessionIdentity: "ues-run-1:gen-1",
}

test("V16.7.1 cache identity: the policy and schema are versioned for the complete key", () => {
  assert.equal(CONSULT_CACHE_SCHEMA_VERSION, 3)
  assert.equal(CONSULT_CACHE_POLICY, "deepseek-consult-cache-v16-7-1")
})

test("V16.7.1 cache identity: profile, task, evidence, repo and session are all folded in", () => {
  const base = consultCacheKey(BASE)
  assert.equal(base, consultCacheKey({ ...BASE }), "the key is deterministic")
  const mutations = [
    ["profileId", { profileId: profileIdFor("work") }],
    ["taskFingerprint", { taskFingerprint: "task-fp-2" }],
    ["evidenceFingerprint", { evidenceFingerprint: "evidence-2" }],
    ["repoFingerprint", { repoFingerprint: "repo-fp-2" }],
    ["sessionIdentity", { sessionIdentity: "ues-run-1:gen-2" }],
  ]
  for (const [field, patch] of mutations) {
    assert.notEqual(base, consultCacheKey({ ...BASE, ...patch }), `a change in ${field} must force a MISS`)
  }
})

test("V16.7.1 cache identity: an absent repo/session keeps its own bucket (never reuses a bound answer)", () => {
  const withSession = consultCacheKey({ ...BASE, sessionIdentity: "ues-run-1:gen-1" })
  const noSession = consultCacheKey({ ...BASE, sessionIdentity: undefined })
  assert.notEqual(withSession, noSession, "a session-less run must not replay a session-bound answer")
  const withRepo = consultCacheKey({ ...BASE, repoFingerprint: "repo-fp-1" })
  const noRepo = consultCacheKey({ ...BASE, repoFingerprint: undefined })
  assert.notEqual(withRepo, noRepo, "a repo-less run must not replay a repo-bound answer")
})

test("V16.7.1 cache identity: a task text change (with no task fingerprint) still invalidates", () => {
  const a = consultCacheKey({ ...BASE, question: "why does the verifier still fail" })
  const b = consultCacheKey({ ...BASE, question: "why does the verifier still fail after the fix" })
  assert.notEqual(a, b)
})

test("V16.7.1 cache identity: no secret, path or raw prompt is recoverable from a key", () => {
  const key = consultCacheKey({
    ...BASE,
    question: "secret-token-abcdef",
    diff: "TOP-SECRET-DIFF-CONTENT",
    constraints: "password=hunter2",
    relevantFiles: [{ path: "C:/Users/me/.deepseek/cookies.json", content: "session=xyz" }],
  })
  assert.match(key, /^[0-9a-f]{64}$/, "the key is an opaque digest")
  for (const secret of ["secret-token-abcdef", "TOP-SECRET-DIFF-CONTENT", "hunter2", "cookies.json", "session=xyz"]) {
    assert.equal(key.includes(secret), false, `the key must not expose ${secret}`)
  }
})

test("V16.7.1 cache identity: a stored answer is never served across a different session or profile", () => {
  const cache = createConsultCache({ maxEntries: 8, ttlMs: 60_000 })
  const k1 = consultCacheKey(BASE)
  cache.put(k1, { answer: "for-personal-gen1" })
  assert.equal(cache.get(k1).answer, "for-personal-gen1")
  // Same everything EXCEPT the session generation -> a different key -> miss.
  assert.equal(cache.get(consultCacheKey({ ...BASE, sessionIdentity: "ues-run-1:gen-2" })), null)
  // Same everything EXCEPT the profile -> a different key -> miss.
  assert.equal(cache.get(consultCacheKey({ ...BASE, profileId: profileIdFor("work") })), null)
})

// ---------------------------------------------------------------------------
// Replay vs live: the controller must label a cache hit distinctly from a real
// provider consultation. This is a SOURCE contract on the shipped extension.
// ---------------------------------------------------------------------------
test("V16.7.1 cache replay: the consulted event distinguishes cache-replay from provider", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes('"cache-replay"'), "a cache hit must be labelled cache-replay")
  assert.ok(source.includes('"provider"'), "a live consultation must be labelled provider")
  assert.ok(source.includes('"stale-discarded"'), "a discarded stale response must be labelled")
  assert.ok(source.includes('"unavailable"') && source.includes('"error"'), "unavailable and error are distinct sources")
  assert.ok(source.includes('"web-reasoning.consulted"'), "the discriminated event is journaled")
  assert.ok(source.includes("source,"), "the event carries the source discriminator")
  // The cache-hit path records a distinct event too.
  assert.ok(source.includes('"v16.6.deepseek.cache-hit"'), "the cache-hit path is separately journaled")
})

test("V16.7.1 cache replay: the shipped call site passes the complete identity", () => {
  const source = readFileSync(EXTENSION, "utf8")
  for (const field of ["taskFingerprint:", "repoFingerprint:", "sessionIdentity:", "profileId:", "evidenceFingerprint:"]) {
    assert.ok(source.includes(field), `the production cache call site must pass ${field}`)
  }
})
