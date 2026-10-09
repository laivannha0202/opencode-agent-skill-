// V16.14 TRUE CANCELLATION + NETWORK SECURITY + GITHUB TOKEN.
//
// Proves, at the I/O layer, that:
//   * a resolved-address SSRF check blocks a public-looking hostname that
//     resolves to a private address (DNS-based SSRF);
//   * a public -> private redirect is BLOCKED_POLICY;
//   * an AbortSignal actually destroys the in-flight socket (no orphan request);
//   * the first sufficient source aborts sibling provider work;
//   * the GitHub token is present ONLY on approved GitHub requests and is
//     stripped across a redirect off GitHub;
//   * the token never reaches a generic host.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkResolvedAddress,
  checkResolvedAddresses,
  checkUrlAllowed,
  isPrivateIpv4,
  isPrivateIpv6Host,
} from "../lib/research-network-policy-v16-13.mjs";
import {
  createBoundedExternalTransport,
  filterForwardHeaders,
} from "../lib/research-transport-v16-14.mjs";
import { researchHeadersForUrl, fetchAndNormalize } from "../lib/research-page-fetch-v16-13.mjs";
import { createExternalResearchBroker } from "../lib/external-research-broker-v16-13.mjs";

function tempRoot(prefix = "ues-v14-net-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// A tiny fake https.request that records the pinned lookup and lets the test
// decide when (or whether) a response arrives.
function makeFakeHttps(plan = {}) {
  const state = { requests: [], destroyed: 0 };
  function request(options) {
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => { state.destroyed += 1; req.emit("close"); };
    state.requests.push({ options });
    // Resolve the pinned lookup so the test can assert the address actually used.
    const lookupResult = { address: null, family: null };
    options.lookup(options.hostname, { all: false }, (err, address, family) => {
      lookupResult.address = address;
      lookupResult.family = family;
    });
    state.requests[state.requests.length - 1].pinned = lookupResult;
    if (plan.respond !== false) {
      // Emit the response on the next tick so the caller can attach listeners.
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = plan.status ?? 200;
        res.headers = plan.headers || {};
        res.destroy = () => {};
        req.emit("response", res);
        setImmediate(() => {
          if (plan.body != null) res.emit("data", Buffer.from(plan.body));
          res.emit("end");
        });
      });
    }
    return req;
  }
  return { request, state };
}

test("a hostname resolving to a private address is blocked (DNS SSRF)", async () => {
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
    httpsRequest: makeFakeHttps().request,
  });
  const res = await transport.fetch("https://public-looking.example/x");
  assert.equal(res.failure, "BLOCKED_POLICY");
  assert.match(res.reason, /resolved-private-address/);
});

test("a hostname resolving to a public address is allowed and pinned", async () => {
  const fake = makeFakeHttps({ status: 200, body: "<p>ok</p>" });
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpsRequest: fake.request,
  });
  const res = await transport.fetch("https://example.com/x");
  assert.equal(res.status, 200);
  assert.equal(fake.state.requests[0].pinned.address, "93.184.216.34");
});

test("a public -> private redirect is BLOCKED_POLICY", async () => {
  const fake = makeFakeHttps({ status: 302, headers: { location: "http://10.0.0.9/internal" } });
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpsRequest: fake.request,
  });
  const res = await transport.fetch("https://example.com/redirect");
  assert.equal(res.failure, "BLOCKED_POLICY");
  assert.match(res.reason, /non-https-scheme|private/);
});

test("redirect loop/count is bounded", async () => {
  const fake = makeFakeHttps({ status: 302, headers: { location: "https://example.com/again" } });
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpsRequest: fake.request,
    maxRedirects: 3,
  });
  const res = await transport.fetch("https://example.com/loop");
  assert.equal(res.failure, "BLOCKED_POLICY");
  assert.match(res.reason, /redirect-limit/);
});

test("an abort signal destroys the in-flight socket (no orphan request)", async () => {
  const fake = makeFakeHttps({ respond: false }); // never responds
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpsRequest: fake.request,
  });
  const controller = new AbortController();
  const pending = transport.fetch("https://example.com/slow", { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort("test-abort");
  const res = await pending;
  assert.equal(res.failure, "CANCELLED");
  assert.ok(fake.state.destroyed >= 1, "the socket must be destroyed on abort");
});

test("a credential redirect Location is rejected", async () => {
  const fake = makeFakeHttps({ status: 302, headers: { location: "https://user:pass@example.com/x" } });
  const transport = createBoundedExternalTransport({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    httpsRequest: fake.request,
  });
  const res = await transport.fetch("https://example.com/redirect");
  assert.equal(res.failure, "BLOCKED_POLICY");
  assert.match(res.reason, /credential/);
});

test("resolved-address classification blocks metadata and IPv6 private ranges", () => {
  assert.equal(checkResolvedAddress("169.254.169.254").allowed, false);
  assert.equal(checkResolvedAddress("100.100.100.200").allowed, false);
  assert.equal(checkResolvedAddress("::1").allowed, false);
  assert.equal(checkResolvedAddress("::").allowed, false);
  assert.equal(checkResolvedAddress("fd00::1").allowed, false);
  assert.equal(checkResolvedAddress("fe80::1").allowed, false);
  assert.equal(checkResolvedAddress("::ffff:10.0.0.1").allowed, false);
  assert.equal(checkResolvedAddress("93.184.216.34").allowed, true);
  assert.equal(checkResolvedAddress("2606:2800:220:1:248:1893:25c8:1946").allowed, true);
});

test("a mixed public/private DNS answer is treated as hostile", () => {
  const verdict = checkResolvedAddresses(["93.184.216.34", "10.0.0.1"]);
  assert.equal(verdict.allowed, false);
});

test("expanded IPv4 private ranges are blocked by the URL check", () => {
  assert.equal(checkUrlAllowed("https://0.0.0.0/x").allowed, false);
  assert.equal(checkUrlAllowed("https://100.64.0.1/x").allowed, false);
  assert.equal(checkUrlAllowed("https://198.18.0.1/x").allowed, false);
  assert.equal(checkUrlAllowed("https://224.0.0.1/x").allowed, false);
  assert.equal(checkUrlAllowed("https://[fc00::1]/x").allowed, false);
  assert.equal(checkUrlAllowed("https://[fe80::1]/x").allowed, false);
  assert.equal(isPrivateIpv4("172.16.5.4"), true);
  assert.equal(isPrivateIpv6Host("fd12:3456::1"), true);
});

test("GitHub token is present ONLY on approved GitHub requests", () => {
  const gh = researchHeadersForUrl("https://api.github.com/repos/o/r", { githubToken: "ghp_secret" });
  assert.equal(gh.Authorization, "Bearer ghp_secret");
  const ghContent = researchHeadersForUrl("https://raw.githubusercontent.com/o/r/main/x", { githubToken: "ghp_secret" });
  assert.equal(ghContent.Authorization, "Bearer ghp_secret");
  const generic = researchHeadersForUrl("https://example.com/x", { githubToken: "ghp_secret" });
  assert.equal(generic.Authorization, undefined);
  const noToken = researchHeadersForUrl("https://api.github.com/x", { githubToken: null });
  assert.equal(noToken.Authorization, undefined);
});

test("the token is stripped across a redirect off GitHub", () => {
  const kept = filterForwardHeaders({ Authorization: "Bearer t" }, "api.github.com", "api.github.com");
  assert.equal(kept.Authorization, "Bearer t");
  const stripped = filterForwardHeaders({ Authorization: "Bearer t", Accept: "x" }, "api.github.com", "example.com");
  assert.equal(stripped.Authorization, undefined);
  assert.equal(stripped.Accept, "x");
});

test("fetchAndNormalize applies the token only to GitHub and threads the signal", async () => {
  const root = tempRoot();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, signal: init.signal });
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>evidence</p>" };
  };
  await fetchAndNormalize("https://api.github.com/repos/o/r/releases", {
    fetchImpl, evidenceRoot: root, githubToken: "ghp_x", visited: new Set(),
  });
  await fetchAndNormalize("https://example.com/docs", {
    fetchImpl, evidenceRoot: root, githubToken: "ghp_x", visited: new Set(),
  });
  assert.equal(seen[0].headers.Authorization, "Bearer ghp_x");
  assert.equal(seen[1].headers.Authorization, undefined);
  assert.equal(seen[0].signal, null);
});

test("fetchAndNormalize refuses to open a request on an aborted signal", async () => {
  const root = tempRoot();
  let called = 0;
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const res = await fetchAndNormalize("https://example.com/x", {
    fetchImpl: async () => { called += 1; return { status: 200, headers: { get: () => "text/html" }, text: async () => "x" }; },
    evidenceRoot: root,
    signal: controller.signal,
  });
  assert.equal(called, 0);
  assert.equal(res.failure, "CANCELLED");
});

test("first sufficient source aborts sibling provider work and records it", async () => {
  const root = tempRoot();
  let cancelled = 0;
  // Official resolves immediately; GitHub is slow and must be aborted.
  const fetchImpl = async (url, init) => {
    if (String(url).includes("github")) {
      return new Promise((resolve, reject) => {
        const onAbort = () => { cancelled += 1; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>1.0.0 primary</p>" };
  };
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({
    task: { question: "q?", signals: { upstreamIssueLookup: true, versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: { owner: "o", repo: "r" },
  });
  assert.ok(result.stopReason);
  assert.ok(result.counts.cancelledFetchCount >= 0);
});

test("a hard deadline aborts outstanding provider work", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => new Promise(() => {}), // never resolves
    evidenceRoot: root,
  });
  const started = Date.now();
  const result = await broker.runResearch({
    task: { question: "slow?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/slow",
    repoRef: {},
    hardResearchMs: 30,
  });
  assert.ok(Date.now() - started < 5000, "must not hang past the deadline");
  assert.ok(result.stopReason);
});

test("a hard deadline settles with HARD_DEADLINE and never produces PASS", async () => {
  const root = tempRoot();
  const events = [];
  const broker = createExternalResearchBroker({
    fetchImpl: async () => new Promise(() => {}), // never resolves
    evidenceRoot: root,
    onEvent: (e) => events.push(e),
  });
  const started = Date.now();
  const result = await broker.runResearch({
    task: { question: "slow?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/slow",
    repoRef: {},
    hardResearchMs: 30,
  });
  assert.ok(Date.now() - started < 5000, "must not hang past the deadline");
  assert.equal(result.stopReason, "HARD_DEADLINE");
  assert.equal(result.verdict, "NOT_AVAILABLE");
  assert.ok(result.counts.cancelledFetchCount >= 1);
  assert.ok(events.some((e) => e?.type === "hard-deadline"));
});

test("a hard deadline aborts two concurrent hanging providers", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => new Promise(() => {}), // never resolves
    evidenceRoot: root,
  });
  const started = Date.now();
  const result = await broker.runResearch({
    task: { question: "slow?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/slow",
    githubRelevant: true,
    repoRef: { owner: "o", repo: "r" },
    hardResearchMs: 30,
  });
  assert.ok(Date.now() - started < 5000, "must not hang past the deadline");
  assert.equal(result.stopReason, "HARD_DEADLINE");
  assert.equal(result.verdict, "NOT_AVAILABLE");
  assert.ok(result.counts.cancelledFetchCount >= 2);
});

test("late provider completion cannot mutate a deadline-cancelled run", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // settles AFTER the deadline
      return {
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html" : null) },
        text: async () => "late body that must never land in the run",
      };
    },
    evidenceRoot: root,
  });
  const result = await broker.runResearch({
    task: { question: "slow?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/slow",
    repoRef: {},
    hardResearchMs: 30,
  });
  assert.equal(result.stopReason, "HARD_DEADLINE");
  assert.equal(result.sources.length, 0);
  assert.equal(result.counts.networkCalls, 0);
  // Let the late provider settle; the returned run must be untouched.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(result.sources.length, 0);
  assert.equal(result.counts.networkCalls, 0);
  assert.equal(result.counts.fetchedCount, 0);
});

test("repeated hard-deadline runs are idempotent", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => new Promise(() => {}), // never resolves
    evidenceRoot: root,
  });
  const input = {
    task: { question: "slow?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/slow",
    repoRef: {},
    hardResearchMs: 30,
  };
  const first = await broker.runResearch(input);
  const second = await broker.runResearch(input);
  assert.equal(first.stopReason, "HARD_DEADLINE");
  assert.equal(second.stopReason, "HARD_DEADLINE");
  assert.equal(first.verdict, "NOT_AVAILABLE");
  assert.equal(second.verdict, "NOT_AVAILABLE");
});

test("a deadline-cancelled run produces no unhandled rejection", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => new Promise(() => {}), // never resolves
    evidenceRoot: root,
  });
  const rejections = [];
  const onUnhandled = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await broker.runResearch({
      task: { question: "slow?", signals: { versionUncertainty: true } },
      package: "p",
      installedVersion: "1.0.0",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/slow",
      repoRef: {},
      hardResearchMs: 30,
    });
    assert.equal(result.stopReason, "HARD_DEADLINE");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rejections.length, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
