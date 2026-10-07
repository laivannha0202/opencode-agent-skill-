// V16.13 Official + GitHub providers: version-matched primaries, token scoping.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOfficialTarget,
  buildOfficialQueries,
  evaluateOfficialVersionMatch,
} from "../lib/research-provider-official-v16-13.mjs";
import {
  GITHUB_PROVIDER_POLICY,
  isGitHubHost,
  authHeadersForHost,
  parseGitHubRepo,
  buildGitHubQueries,
  classifyGitHubFailure,
} from "../lib/research-provider-github-v16-13.mjs";

test("github policy id is byte-stable", () => {
  assert.equal(GITHUB_PROVIDER_POLICY, "research-provider-github-v16-13");
});

test("official domain is never guessed", () => {
  const unknown = resolveOfficialTarget({ packageName: "some-obscure-pkg-xyz", repository: null, homepage: null, registry: null });
  assert.equal(unknown.unknown, true);
  const known = resolveOfficialTarget({ packageName: "react" });
  assert.equal(known.domain, "react.dev");
});

test("official queries prefer exact-version docs and stay bounded", () => {
  const queries = buildOfficialQueries({ maxQueries: 2, question: "middleware" }, { package: "next", installedVersion: "15.4.0" }, { domain: "nextjs.org" });
  assert.ok(queries.length <= 2);
  assert.ok(queries[0].query.includes("15.4.0"));
});

test("latest docs are recorded as LATEST_ONLY, never silent match", () => {
  const verdict = evaluateOfficialVersionMatch(
    { canonicalUrl: "https://nextjs.org/docs", title: "docs", excerpt: "latest docs" },
    { installedVersion: "15.4.0" },
  );
  assert.equal(verdict.versionMatch, "LATEST_ONLY");
  assert.match(verdict.note, /exact-version-docs-unavailable/);
});

test("github token never leaves github hosts and is never logged", () => {
  assert.equal(isGitHubHost("api.github.com"), true);
  assert.equal(isGitHubHost("evil.example.com"), false);
  const gh = authHeadersForHost("https://api.github.com/repos/a/b", { token: "SECRET" });
  assert.ok(String(gh.Authorization || "").includes("SECRET"));
  const other = authHeadersForHost("https://evil.example.com/x", { token: "SECRET" });
  assert.equal(other.Authorization, undefined);
  assert.ok(!JSON.stringify(other).includes("SECRET"));
});

test("github rate limit is a fallback, not a global failure", () => {
  const failure = classifyGitHubFailure({ status: 429, body: "" });
  assert.equal(failure.kind, "RATE_LIMIT");
  assert.equal(failure.fallback, true);
  const queries = buildGitHubQueries({ maxQueries: 3, question: "breaking change" }, { owner: "vercel", repo: "next.js" });
  assert.ok(queries.length <= 3);
  assert.ok(parseGitHubRepo("https://github.com/vercel/next.js").owner === "vercel");
});
