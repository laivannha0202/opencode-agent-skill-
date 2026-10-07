// V16.13 Claims: SUPPORTED/PARTIAL/CONFLICTED/UNSUPPORTED/UNVERIFIED; no
// silent first-source-wins; DeepSeek unsourced stays unverified.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_STATUS,
  trackClaims,
  resolveContradictions,
  buildResearchCapsule,
} from "../lib/external-research-broker-v16-13.mjs";

const sourceA = { sourceId: "aaa", provider: "official-docs", domain: "x", canonicalUrl: "https://x/a", excerpt: "a", contentHash: "a".repeat(64) };
const sourceB = { sourceId: "bbb", provider: "github", domain: "github.com", canonicalUrl: "https://github.com/o/r", excerpt: "b", contentHash: "b".repeat(64) };

test("claim statuses classify deterministically", () => {
  const tracked = trackClaims([
    { id: "c1", text: "api exists", sourceIds: ["aaa"] },
    { id: "c2", text: "partial", sourceIds: ["aaa", "zzz"], partial: true },
    { id: "c3", text: "no source", sourceIds: [] },
    { id: "c4", text: "advisor guess", sourceIds: [], fromDeepSeek: true },
    { id: "c5", text: "fight", sourceIds: ["aaa"], conflicted: true },
  ], [sourceA]);
  const byId = Object.fromEntries(tracked.map((c) => [c.id, c.status]));
  assert.equal(byId.c1, CLAIM_STATUS.SUPPORTED);
  assert.equal(byId.c2, CLAIM_STATUS.PARTIALLY_SUPPORTED);
  assert.equal(byId.c3, CLAIM_STATUS.UNSUPPORTED);
  assert.equal(byId.c4, CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM);
  assert.equal(byId.c5, CLAIM_STATUS.CONFLICTED);
});

test("unsourced DeepSeek claim stays unverified, never promoted", () => {
  const tracked = trackClaims([{ id: "d1", text: "deep says x", sourceIds: [], fromDeepSeek: true }], [sourceA]);
  assert.equal(tracked[0].status, CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM);
});

test("contradictions resolve version-matched primary first, never silent first-win", () => {
  const versionMatched = { ...sourceA, sourceId: "vm1", versionMatch: true };
  const resolution = resolveContradictions([{ id: "k", text: "x", sourceIds: ["vm1"], conflicted: true }], [versionMatched, sourceB], {});
  assert.equal(resolution.resolution, "exact-installed-version-primary-wins");
  assert.equal(resolution.needsSynthesis, false);
  const noPrimary = resolveContradictions([{ id: "k", text: "x", sourceIds: ["bbb"], conflicted: true }], [sourceB], {});
  assert.equal(noPrimary.conflicted.length, 1);
});

test("capsule is bounded at 8000 chars and pins facts", () => {
  const capsule = buildResearchCapsule({
    brief: { briefId: "b1", researchClass: "GITHUB_RESEARCH" },
    versionJoin: { package: "p", installedVersion: "1.0.0", latestVersion: "2.0.0", versionRelation: "BEHIND_MAJOR" },
    sources: [sourceA, sourceB],
    claims: [{ id: "c1", text: "fact one", sourceIds: ["aaa"] }],
    conflicts: [],
    recommendation: "stay on installed",
    stopReason: "ANSWERED",
  });
  assert.ok(capsule.text.length <= 8000);
  assert.equal(capsule.pinned, true);
});
