// V16.13 Provider router: primary sources first, smallest set, fallback.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESEARCH_ROUTER_POLICY,
  RESEARCH_PROVIDER,
  routeProviders,
  selectFallback,
} from "../lib/research-provider-router-v16-13.mjs";
import { RESEARCH_CLASS } from "../lib/research-brief-v16-13.mjs";

test("router policy id is byte-stable", () => {
  assert.equal(RESEARCH_ROUTER_POLICY, "research-provider-router-v16-13");
});

test("LOCAL_ONLY routes to no provider", () => {
  const routes = routeProviders({ researchClass: RESEARCH_CLASS.LOCAL_ONLY });
  assert.deepEqual(routes.ordered, []);
  assert.equal(routes.maxConcurrent, 0);
});

test("official-doc class starts with official docs, generic never by default", () => {
  const routes = routeProviders({ researchClass: RESEARCH_CLASS.OFFICIAL_DOC_REQUIRED, maxQueries: 2 });
  assert.equal(routes.ordered[0].provider, RESEARCH_PROVIDER.OFFICIAL_DOCS);
  assert.ok(!routes.ordered.some((r) => r.provider === RESEARCH_PROVIDER.GENERIC_SEARCH));
  assert.ok(routes.maxConcurrent <= 2);
});

test("Official + GitHub sufficient means generic web never starts", () => {
  const routes = routeProviders({ researchClass: RESEARCH_CLASS.CURRENT_WEB_RESEARCH });
  assert.ok(!routes.ordered.some((r) => r.provider === RESEARCH_PROVIDER.GENERIC_SEARCH));
  const withNeed = routeProviders({ researchClass: RESEARCH_CLASS.CURRENT_WEB_RESEARCH }, { genericNeeded: true, primaryInsufficient: true });
  assert.ok(withNeed.ordered.some((r) => r.provider === RESEARCH_PROVIDER.GENERIC_SEARCH));
});

test("DeepSeek synthesis is gated, never default", () => {
  const plain = routeProviders({ researchClass: RESEARCH_CLASS.DEEP_RESEARCH });
  assert.ok(!plain.ordered.some((r) => r.provider === RESEARCH_PROVIDER.DEEPSEEK_SYNTHESIS));
  const conflict = routeProviders({ researchClass: RESEARCH_CLASS.DEEP_RESEARCH }, { synthesisNeeded: true });
  assert.ok(conflict.ordered.some((r) => r.provider === RESEARCH_PROVIDER.DEEPSEEK_SYNTHESIS));
});

test("fallback prefers alternate capable provider, then local", () => {
  const first = selectFallback("official-docs", { researchClass: RESEARCH_CLASS.CURRENT_WEB_RESEARCH, maxQueries: 3 }, { kind: "TIMEOUT", idempotent: true, attempts: 0 });
  assert.equal(first.action, "retry-same-provider-once");
  const second = selectFallback("official-docs", { researchClass: RESEARCH_CLASS.LOCAL_ONLY }, { kind: "BLOCKED_POLICY", idempotent: false, attempts: 1 });
  assert.equal(second.provider, RESEARCH_PROVIDER.LOCAL_FALLBACK);
});
