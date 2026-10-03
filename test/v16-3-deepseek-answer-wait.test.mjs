// V16.3 DeepSeek answer-wait blocker fix: answer acquisition / answer-wait.
//
// Covers the final live blocker where the FIRST answer snapshot failed and the
// failure was collapsed into `deepseek-no-answer-extracted:answer-wait`, and
// where the generic SNAPSHOT read whole-page body text as the "answer".
//
// Deterministic. No browser, no network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_ANSWER_MAX_CHARS,
  DEEPSEEK_ANSWER_POLL_STATE,
  classifyAnswerPoll,
  emptyAnswerBaseline,
  isNewAnswerObserved,
  isPartialJson,
  normalizeAnswerBaseline,
  preserveAnswerReadFailure,
  sanitizeAnswerObservation,
  shouldRecoverAnswerRead,
} from "../lib/deepseek-answer.mjs";
import {
  DEEPSEEK_ANSWER_CANDIDATES,
  answerRegionsScript,
  sanitizeAnswerRegions,
} from "../lib/deepseek-locators.mjs";
import {
  DEEPSEEK_FAILURE_STAGE,
  DEEPSEEK_WEB_FAILURE,
  classifyDeepSeekSmokeStatus,
  createDeepSeekWebAdapter,
  readAnswerBaseline,
} from "../lib/deepseek-web-adapter.mjs";
import { preflightBrowserCapability } from "../lib/browser-capability.mjs";
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; return value; },
    sleep: async (ms) => { value += Number(ms) || 0; },
  };
}

function goodAdviceJson(summary = "s") {
  return JSON.stringify({
    summary,
    hypotheses: [],
    recommendedApproach: [],
    filesToInspect: [],
    risks: [],
    edgeCases: [],
    verificationSuggestions: [],
    confidence: 0.5,
  });
}

function composerVicinity() {
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-composer-vicinity",
    url: "https://chat.deepseek.com/",
    composers: [
      { selector: "textarea", visible: 1, rows: [{ index: 0, tag: "textarea", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }] },
      { selector: '[contenteditable="true"]', visible: 0, rows: [] },
      { selector: 'input[type="text"]', visible: 0, rows: [] },
    ],
    composerContext: null,
    sendNearby: [
      { index: 0, tag: "div", role: "button", disabled: false, ariaLabel: { present: true, generic: "send" }, controlName: { present: false, generic: null }, testId: null, type: null, hasSvg: true, childCount: 2, box: { w: 34, h: 34 }, tabIndex: 0, distance: 1, afterComposer: true },
    ],
    sendTotal: 1,
    sendMatches: {},
    answers: {},
    semanticCounts: { sendExact: 0, sendGeneric: 0, submitGeneric: 0, stopGeneric: 0, attachGeneric: 0, uploadGeneric: 0, fileGeneric: 0, voiceGeneric: 0, microphoneGeneric: 0 },
    disclosure: { pageTextRead: false, inputValuesRead: false, cookiesRead: false, storageRead: false, conversationTitlesRead: false, accountNameRead: false, acted: false },
  };
}

function answerRegionsEmpty() {
  return {
    families: [
      { selectorKey: "data-message-role-assistant", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "data-role-assistant", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "ds-markdown", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "assistant-class", visibleCount: 0, latestTextChars: 0 },
    ],
    counts: {
      "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 0, "assistant-class": 0,
    },
    selected: null,
    totalVisible: 0,
  };
}

function answerRegionsWith(key, count, text) {
  const families = [
    { selectorKey: "data-message-role-assistant", visibleCount: 0, latestTextChars: 0 },
    { selectorKey: "data-role-assistant", visibleCount: 0, latestTextChars: 0 },
    { selectorKey: "ds-markdown", visibleCount: 0, latestTextChars: 0 },
    { selectorKey: "assistant-class", visibleCount: 0, latestTextChars: 0 },
  ];
  for (const row of families) {
    if (row.selectorKey === key) {
      row.visibleCount = count;
      row.latestTextChars = String(text || "").length;
    }
  }
  const counts = {};
  for (const row of families) counts[row.selectorKey] = row.visibleCount;
  return {
    families,
    counts,
    selected: count > 0 ? { selectorKey: key, visibleCount: count, textChars: String(text || "").length, answerText: String(text || "") } : null,
    totalVisible: count,
  };
}

async function testAdapter({ answerQueue = [], invokeOverrides = {}, clock = null, answerBelongsToRequest = null } = {}) {
  const capability = preflightBrowserCapability({
    tools: ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_click", "mcp__playwright__browser_fill_form", "mcp__playwright__browser_navigate"],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  });
  const useClock = clock || fakeClock();
  const queue = [...answerQueue];
  const domInspectCalls = [];
  const deps = {
    capability,
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    domInspect: async (opts = {}) => {
      const mode = String(opts.mode || "");
      domInspectCalls.push(mode);
      if (mode === "composer-vicinity") return { ok: true, vicinity: composerVicinity() };
      if (mode === "deepseek-answer-regions") {
        const next = queue.length ? queue.shift() : answerRegionsEmpty();
        if (next && next.ok === false) return next;
        return { ok: true, answerRegions: next };
      }
      return { ok: true, vicinity: composerVicinity() };
    },
    now: useClock.now,
    sleep: useClock.sleep,
    answerTimeoutMs: 5_000,
  };
  if (answerBelongsToRequest) deps.answerBelongsToRequest = answerBelongsToRequest;
  const calls = [];
  deps.invoke = async (action, context) => {
    calls.push(action);
    if (invokeOverrides[action]) return invokeOverrides[action](context, calls);
    if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
    if (action === "fill") return { ok: true, filledChars: 20 };
    if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
    if (action === "snapshot") return { ok: true, result: { answer: "" } };
    return { ok: true };
  };
  const adapter = createDeepSeekWebAdapter(deps);
  return { adapter, calls, domInspectCalls, clock: useClock, deps };
}

async function startReadySession(adapter) {
  const session = await adapter.startSession({});
  assert.equal(session.state, "ready");
  return session;
}

// --- 1: first poll empty continues, not NO_ANSWER ----------------------------

test("V16.3 answer 1 first poll empty continues, second poll success", async () => {
  const fresh = goodAdviceJson("fresh-1");
  const { adapter, calls } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(), // baseline (pre-submit)
      answerRegionsEmpty(), // poll 1: NO_REGION_YET
      answerRegionsWith("ds-markdown", 1, fresh), // poll 2: new region
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-1" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("fresh-1"));
  assert.equal(result.submitAttempts, 1);
  assert.equal(calls.filter((a) => a === "fill").length, 1);
  assert.equal(calls.filter((a) => a === "click").length, 1);
});

// --- 2: second/third poll gets new region => success -------------------------

test("V16.3 answer 2 third poll new region succeeds after two empties", async () => {
  const fresh = goodAdviceJson("fresh-2");
  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      answerRegionsEmpty(),
      answerRegionsEmpty(),
      answerRegionsWith("data-message-role-assistant", 1, fresh),
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-2" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("fresh-2"));
});

// --- 3: partial JSON keeps polling -------------------------------------------

test("V16.3 answer 3 partial JSON keeps polling until complete", async () => {
  const partial = '{"summary": "half-streamed';
  const full = goodAdviceJson("streamed-complete");
  assert.equal(isPartialJson(partial), true, "partial must be detected");
  assert.equal(isPartialJson(full), false, "complete JSON is not partial");
  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      answerRegionsWith("ds-markdown", 1, partial),
      answerRegionsWith("ds-markdown", 1, full),
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-3" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("streamed-complete"));
});

// --- 4: valid JSON stops polling ---------------------------------------------

test("V16.3 answer 4 valid JSON stops polling immediately", async () => {
  const full = goodAdviceJson("valid-stop");
  const { adapter } = await testAdapter({
    answerQueue: [answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, full)],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-4" });
  assert.equal(result.ok, true);
  const state = classifyAnswerPoll({
    observation: sanitizeAnswerObservation({ selectorKey: "ds-markdown", visibleCount: 1, baselineCount: 0, textChars: full.length, answerText: full, counts: { "ds-markdown": 1 } }),
    baseline: emptyAnswerBaseline(),
    parseResult: { ok: true },
  });
  assert.equal(state, DEEPSEEK_ANSWER_POLL_STATE.VALID_COMPLETE_JSON);
});

// --- 5: old baseline region rejected ----------------------------------------

test("V16.3 answer 5 old baseline region is rejected, not accepted", async () => {
  const oldText = goodAdviceJson("old-answer");
  const fresh = goodAdviceJson("fresh-5");
  // Baseline already has 1 old region; first poll same count/old text must not win.
  const baselineWithOld = {
    families: [
      { selectorKey: "data-message-role-assistant", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "data-role-assistant", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "ds-markdown", visibleCount: 1, latestTextChars: oldText.length },
      { selectorKey: "assistant-class", visibleCount: 0, latestTextChars: 0 },
    ],
    counts: { "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 },
    selected: { selectorKey: "ds-markdown", visibleCount: 1, textChars: oldText.length, answerText: oldText },
    totalVisible: 1,
  };
  const sameOld = answerRegionsWith("ds-markdown", 1, oldText);
  const withFresh = (() => {
    const r = answerRegionsWith("ds-markdown", 2, fresh);
    // Two regions now: count increased => new answer.
    r.families.find((f) => f.selectorKey === "ds-markdown").visibleCount = 2;
    r.counts["ds-markdown"] = 2;
    r.selected = { selectorKey: "ds-markdown", visibleCount: 2, textChars: fresh.length, answerText: fresh };
    r.totalVisible = 2;
    return r;
  })();
  assert.equal(isNewAnswerObserved(sanitizeAnswerObservation({ selectorKey: "ds-markdown", visibleCount: 1, textChars: oldText.length, answerText: oldText, counts: sameOld.counts }), normalizeAnswerBaseline(baselineWithOld.counts)), false, "same count must not be new");
  assert.equal(isNewAnswerObserved(sanitizeAnswerObservation({ selectorKey: "ds-markdown", visibleCount: 2, textChars: fresh.length, answerText: fresh, counts: withFresh.counts }), normalizeAnswerBaseline(baselineWithOld.counts)), true, "increased count is new");

  const { adapter } = await testAdapter({
    answerQueue: [baselineWithOld, sameOld, withFresh],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-5" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("fresh-5"), "only the new answer may be accepted");
  assert.ok(!String(result.answer).includes("old-answer"));
});

// --- 6: count increases after submit => accepted ------------------------------

test("V16.3 answer 6 count increase after submit proves ownership", async () => {
  const fresh = goodAdviceJson("fresh-6");
  const { adapter } = await testAdapter({
    answerQueue: [answerRegionsEmpty(), answerRegionsWith("data-role-assistant", 1, fresh)],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-6" });
  assert.equal(result.ok, true);
  assert.ok(result.answerBaseline, "baseline must be reported");
  assert.deepEqual(
    { ...result.answerBaseline, _source: undefined, _available: undefined },
    { ...emptyAnswerBaseline(), _source: undefined, _available: undefined },
  );
  assert.ok(result.answerSelectorCounts, "selector counts must be reported");
});

// --- 7: whole-page body text never used --------------------------------------

test("V16.3 answer 7 whole-page body text is never used as the answer", async () => {
  const adapterSrc = await readFile(path.join(root, "lib", "deepseek-web-adapter.mjs"), "utf8");
  const codeOnly = adapterSrc.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
  // The legacy `result.text` fallback was whole-page body text. It must be gone from code.
  assert.ok(!codeOnly.includes("result?.text"), "adapter must not read result.text as answer");
  assert.ok(!codeOnly.includes("result.text"), "adapter must not read result.text as answer");
  assert.ok(!codeOnly.includes("document.body.innerText"), "adapter must not evaluate body text");
  const script = answerRegionsScript({});
  assert.ok(!script.includes("document.body.innerText"), "answer script must not read whole-page body text");
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const answerBlock = worker.slice(worker.indexOf("deepseek-answer-regions"), worker.indexOf("deepseek-answer-regions") + 3000);
  assert.ok(!answerBlock.includes("document.body.innerText"), "worker answer path must not read body text");
});

// --- 8: sidebar/history text never enters result ------------------------------

test("V16.3 answer 8 sidebar and history text never enter the answer result", async () => {
  const nasty = {
    families: [{ selectorKey: "ds-markdown", visibleCount: 1, latestTextChars: 10 }],
    counts: { "ds-markdown": 1 },
    selected: { selectorKey: "ds-markdown", visibleCount: 1, textChars: 4, answerText: "ok" },
    totalVisible: 1,
    sidebarText: "Q3 revenue thread",
    historyTitles: ["secret chat 1"],
    accountName: "Ada",
    bodyText: "whole page",
    cookie: "sid=1",
  };
  const clean = sanitizeAnswerRegions(nasty);
  const serialized = JSON.stringify(clean);
  // Values must never survive; disclosure key names (e.g. bodyTextRead:false)
  // state what was NOT read and are expected.
  for (const forbidden of ["Q3", "secret chat", "Ada", "whole page", "sid=1"]) {
    assert.ok(!serialized.includes(forbidden), `answer observation leaked value ${forbidden}`);
  }
  assert.ok(!("sidebarText" in clean) && !("historyTitles" in clean) && !("accountName" in clean) && !("cookie" in clean), "raw sidebar/history/account fields must be dropped");
  assert.equal(clean.selected.answerText, "ok");
  const obs = sanitizeAnswerObservation({ selectorKey: "ds-markdown", visibleCount: 1, answerText: "ok", sidebarText: "leak", bodyText: "leak" });
  // sanitizeAnswerObservation only keeps allowlisted fields; extra text fields are dropped.
  assert.equal(obs.answerText, "ok");
  assert.ok(!("sidebarText" in obs) && !("bodyText" in obs), "extra text fields must be dropped");
});

// --- 9: answer text bounded ---------------------------------------------------

test("V16.3 answer 9 answer text is bounded to 40k chars", async () => {
  const huge = "x".repeat(50_000);
  const obs = sanitizeAnswerObservation({ selectorKey: "ds-markdown", visibleCount: 1, textChars: huge.length, answerText: huge });
  assert.ok(obs.answerText.length <= DEEPSEEK_ANSWER_MAX_CHARS, `got ${obs.answerText.length}`);
  assert.equal(obs.answerText.length, 40_000);
  assert.equal(DEEPSEEK_ANSWER_MAX_CHARS, 40_000);
  const clean = sanitizeAnswerRegions({ families: [{ selectorKey: "ds-markdown", visibleCount: 1, latestTextChars: 50000 }], selected: { selectorKey: "ds-markdown", visibleCount: 1, textChars: 50000, answerText: huge }, totalVisible: 1 });
  assert.ok(clean.selected.answerText.length <= 40_000);
});

// --- 10: transient failure then success recovers read-only --------------------

test("V16.3 answer 10 first transient read failure then success recovers read-only", async () => {
  const fresh = goodAdviceJson("recovered-10");
  const calls = [];
  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "browser-worker-timeout", failure: "browser-worker-timeout" },
      answerRegionsWith("ds-markdown", 1, fresh),
    ],
  });
  // Wrap invoke to count fills/clicks.
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-10" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("recovered-10"));
  assert.equal(result.submitAttempts, 1, "submit must stay exactly 1 through read recovery");
  assert.equal(result.fillAttempts, 1);
  assert.ok((result.snapshotAttempts || 0) >= 2, "polls happened");
  void calls;
});

// --- 11: repeated infrastructure failures preserve exact cause ----------------

test("V16.3 answer 11 repeated infrastructure failures preserve the exact cause", async () => {
  const preserved = preserveAnswerReadFailure({ outcome: "failed", reason: "browser-worker-timeout", failure: { kind: "timeout" } }, 3);
  assert.equal(preserved.answerReadFailure, "browser-worker-timeout");
  assert.equal(preserved.answerReadAttempts, 3);
  assert.equal(shouldRecoverAnswerRead(1), true);
  assert.equal(shouldRecoverAnswerRead(2), true);
  assert.equal(shouldRecoverAnswerRead(3), false, "third consecutive failure must not recover");

  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "browser-worker-timeout", failure: "browser-worker-timeout" },
      { ok: false, reason: "browser-worker-timeout", failure: "browser-worker-timeout" },
      { ok: false, reason: "browser-worker-timeout", failure: "browser-worker-timeout" },
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-11" });
  assert.equal(result.ok, false);
  assert.match(String(result.failure), /browser-worker-timeout/, "exact infrastructure reason must survive");
  assert.ok(!String(result.failure).match(/^deepseek-no-answer-extracted:answer-wait$/), "must not collapse to bare NO_ANSWER");
  assert.equal(result.submitAttempts, 1);
});

// --- 12: auth-required terminal ------------------------------------------------

test("V16.3 answer 12 auth-required during answer wait is terminal", async () => {
  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "browser-auth-required", failure: "browser-worker-auth-required" },
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-12" });
  assert.equal(result.ok, false);
  assert.match(String(result.failure), /deepseek-auth-required/);
  assert.equal(result.submitAttempts, 1);
});

// --- 13: stale selector => UI_CHANGED ------------------------------------------

test("V16.3 answer 13 stale selector is UI_CHANGED, not NO_ANSWER", async () => {
  const { adapter } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "stale-locator: waiting for selector", failure: "stale-locator" },
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-13" });
  assert.equal(result.ok, false);
  assert.match(String(result.failure), /deepseek-ui-selector-changed/);
  assert.ok(!String(result.failure).startsWith(DEEPSEEK_WEB_FAILURE.NO_ANSWER) || String(result.failure).includes("ui-selector-changed"), "stale must not be bare NO_ANSWER");
});

// --- 14: timeout => response-timeout:answer-wait --------------------------------

test("V16.3 answer 14 deadline with no region is response-timeout:answer-wait", async () => {
  const clock = fakeClock();
  const { adapter } = await testAdapter({
    clock,
    answerQueue: Array.from({ length: 30 }, () => answerRegionsEmpty()),
  });
  // Short timeout: override via deps is 5s; sleep advances clock each poll.
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-14" });
  assert.equal(result.ok, false);
  assert.match(String(result.failure), /deepseek-response-timeout:answer-wait/);
});

// --- 15: invalid completed answer => answer-parse -------------------------------

test("V16.3 answer 15 stabilized invalid answer is answer-parse", async () => {
  const clock = fakeClock();
  const invalid = "hello world, this is not JSON and never will be";
  assert.equal(isPartialJson(invalid), false, "plain prose is not partial JSON");
  // Same invalid text every poll; clock advances 1s per sleep => stable after 4s.
  const { adapter } = await testAdapter({
    clock,
    answerQueue: [answerRegionsEmpty(), ...Array.from({ length: 20 }, () => answerRegionsWith("ds-markdown", 1, invalid))],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-15" });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.failure), /deepseek-response-invalid:answer-parse/);
});

// --- 16/17/18: submit stays 1, no click/fill during polls -----------------------

test("V16.3 answer 16 submitAttempts stays 1 during all answer polls", async () => {
  const fresh = goodAdviceJson("fresh-16");
  const capability = preflightBrowserCapability({
    tools: ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_click", "mcp__playwright__browser_fill_form", "mcp__playwright__browser_navigate"],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  });
  const clock = fakeClock();
  const queue = [answerRegionsEmpty(), answerRegionsEmpty(), answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, fresh)];
  const calls = [];
  const adapter = createDeepSeekWebAdapter({
    capability,
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    domInspect: async (opts = {}) => {
      if (String(opts.mode) === "composer-vicinity") return { ok: true, vicinity: composerVicinity() };
      const next = queue.length ? queue.shift() : answerRegionsEmpty();
      if (next && next.ok === false) return next;
      return { ok: true, answerRegions: next };
    },
    now: clock.now,
    sleep: clock.sleep,
    answerTimeoutMs: 5_000,
    invoke: async (action) => {
      calls.push(action);
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-16" });
  assert.equal(result.ok, true);
  assert.equal(result.submitAttempts, 1);
  assert.equal(calls.filter((a) => a === "click").length, 1, "exactly one click total");
  assert.equal(calls.filter((a) => a === "fill").length, 1, "exactly one fill total");
});

test("V16.3 answer 17 no click during answer retry", async () => {
  const fresh = goodAdviceJson("fresh-17");
  const { adapter, calls } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "browser-worker-timeout", failure: "browser-worker-timeout" },
      answerRegionsEmpty(),
      answerRegionsWith("ds-markdown", 1, fresh),
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-17" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((a) => a === "click").length, 1);
});

test("V16.3 answer 18 no fill during answer retry", async () => {
  const fresh = goodAdviceJson("fresh-18");
  const { adapter, calls } = await testAdapter({
    answerQueue: [
      answerRegionsEmpty(),
      { ok: false, reason: "browser-worker-provider-error", failure: "browser-worker-provider-error" },
      answerRegionsWith("ds-markdown", 1, fresh),
    ],
  });
  const session = await startReadySession(adapter);
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "ans-18" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((a) => a === "fill").length, 1);
});

// --- 19: external-side-effect retry remains 0 -----------------------------------

test("V16.3 answer 19 external-side-effect retry remains 0", async () => {
  const click = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  assert.equal(click.requiresExplicitApproval, true);
});

// --- 20: promptFilled/promptSubmitted use counters ------------------------------

test("V16.3 answer 20 smoke checks use action counters, not webReasoningCalls", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  assert.ok(smoke.includes("promptFilled"), "smoke must check promptFilled from counters");
  assert.ok(smoke.includes("promptSubmitted"), "smoke must check promptSubmitted from counters");
  assert.ok(smoke.includes("liveCounters.fillAttempts === 1") || smoke.includes("fillAttempts === 1"), "promptFilled must be fillAttempts===1");
  assert.ok(smoke.includes("liveCounters.submitAttempts === 1") || smoke.includes("submitAttempts === 1"), "promptSubmitted must be submitAttempts===1");
  // The misleading check must be gone from live CODE (comments stripped): the
  // checks object must not define a promptInserted key from telemetry.
  const liveRaw = smoke.slice(smoke.indexOf("// ---- --live:"), smoke.length);
  const codeOnly = liveRaw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/promptInserted\s*:/.test(codeOnly), "misleading promptInserted check must be removed from live checks");
  assert.ok(/promptFilled\s*:/.test(codeOnly) && /promptSubmitted\s*:/.test(codeOnly), "live checks must define promptFilled/promptSubmitted");
});

// --- 21: answer diagnostic submitAttempts=0 -------------------------------------

test("V16.3 answer 21 answer diagnostic never submits", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  assert.ok(smoke.includes("--answer-diagnose"), "diagnostic must be an explicit flag");
  const start = smoke.indexOf("if (args.answerDiagnose)");
  assert.ok(start >= 0);
  const end = smoke.indexOf("// ---- preflight: observe", start);
  const block = smoke.slice(start, end >= 0 ? end : start + 8000);
  assert.ok(block.includes("const submitAttempts = 0"), "diagnostic submitAttempts must be 0");
  assert.ok(block.includes("NO_EXISTING_ANSWER_TO_DIAGNOSE"), "empty diagnostic must report honestly");
  assert.ok(!block.match(/invoke\s*\(\s*"click"/), "diagnostic must never click");
  assert.ok(!block.match(/invoke\s*\(\s*"fill"/), "diagnostic must never fill");
  assert.ok(block.includes("deepseek-answer-regions"), "diagnostic must use the scoped answer path");
});

// --- 22: diagnostic never reads body.innerText -----------------------------------

test("V16.3 answer 22 answer diagnostic never reads body.innerText", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const start = smoke.indexOf("if (args.answerDiagnose)");
  const block = smoke.slice(start, smoke.indexOf("// ---- preflight: observe", start));
  assert.ok(!block.includes("body.innerText"), "diagnostic must not read whole-page body text");
  assert.ok(!block.includes("answerText") || block.includes("answerTextChars"), "diagnostic reports chars, not text by default");
  const script = answerRegionsScript({});
  assert.ok(!script.includes("document.body.innerText"));
  // The diagnostic prints counts/strategy/chars only.
  assert.ok(block.includes("answerSelectorCounts"));
  assert.ok(block.includes("selectedAnswerStrategy"));
  assert.ok(block.includes("answerTextChars"));
});

// --- 23: existing auth/composer/transition unchanged ------------------------------

test("V16.3 answer 23 existing auth/composer/transition behavior unchanged", async () => {
  const { AUTH_SETTLE_LIMIT, classifyAuthState, AUTH_PROBE_STATE } = await import("../lib/browser-profile.mjs");
  assert.equal(AUTH_SETTLE_LIMIT.maxAttempts, 5);
  assert.equal(AUTH_SETTLE_LIMIT.intervalMs, 1000);
  assert.equal(AUTH_SETTLE_LIMIT.overallTimeoutMs, 6000);
  const first = classifyAuthState({ url: "https://chat.deepseek.com/", composerVisible: true, accountSignal: false, answerRegions: 0, historyCount: 0 });
  assert.equal(first.state, AUTH_PROBE_STATE.UNKNOWN);
  const second = classifyAuthState({ url: "https://chat.deepseek.com/", composerVisible: true, accountSignal: false, answerRegions: 0, historyCount: 50 });
  assert.equal(second.state, AUTH_PROBE_STATE.READY);
  assert.equal(classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED }), "UI_CHANGED");
  assert.equal(classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }), "NEEDS_AUTH");
  // Answer candidates retained.
  assert.deepEqual(DEEPSEEK_ANSWER_CANDIDATES.map((c) => c.selector), ["[data-message-role='assistant']", "[data-role='assistant']", ".ds-markdown", "[class*='assistant']"]);
  // Failure stages preserved.
  assert.equal(DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT, "answer-wait");
  assert.equal(DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE, "answer-parse");
});
