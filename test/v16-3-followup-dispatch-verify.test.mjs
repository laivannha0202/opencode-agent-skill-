// V16.3 follow-up dispatch-verification regression.
//
// PRODUCTION EVIDENCE (one bounded live run, persistent profile):
//   INITIAL: fillAttempts=1, submitAttempts=1, response extracted, parser ok,
//     session reusable.
//   FOLLOW-UP: SAME session reused, state before submit=ready, fillAttempts=1,
//     submitAttempts=1, no deepseek-session-lost, total external submits=2,
//     but outcome=unavailable with
//     `deepseek-ui-selector-changed:dispatch-verify:submit-unverified` and
//     response extraction never started.
//
// ROOT CAUSE (exact failing predicate): `deepSeekDefaultVerify` proves a click
// dispatched via `urlMoved || inputCleared` (REQUIRED). Both are
// initial-consult-only signals: the first prompt creates a new conversation
// (URL moves), and the production worker hard-codes `inputCleared: false` on
// every click. A follow-up inside the SAME conversation moves no URL, so a
// successfully executed Send fails the REQUIRED expectation and the answer
// phase never starts -- even though the message is streaming.
//
// FIX: on a follow-up whose click transport demonstrably ran but whose
// REQUIRED dispatch expectation failed, ONE bounded read-only
// composer-vicinity read may still prove dispatch via follow-up-valid POSITIVE
// signals (visible streaming Stop control, answer-region growth vs the
// pre-submit baseline). Confirmed dispatches proceed to the answer phase;
// anything else returns the identical failure as before.
//
// This file is deterministic. No browser, no network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_FAILURE_STAGE,
  confirmFollowUpDispatch,
  createDeepSeekWebAdapter,
} from "../lib/deepseek-web-adapter.mjs";
import { preflightBrowserCapability } from "../lib/browser-capability.mjs";
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs";
import { browserRetryDecision } from "../lib/browser-retry-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOME_URL = "https://chat.deepseek.com/";
const CONV_URL = "https://chat.deepseek.com/a/fu-dispatch-1";

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

function sendButton(generic = "send") {
  return {
    index: 0, tag: "div", role: "button", disabled: false,
    ariaLabel: { present: true, generic }, controlName: { present: false, generic: null },
    testId: null, type: null, hasSvg: true, childCount: 2, box: { w: 34, h: 34 },
    tabIndex: 0, distance: 1, afterComposer: true,
  };
}

function composerVicinity(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-composer-vicinity",
    url: HOME_URL,
    composers: [
      { selector: "textarea", visible: 1, rows: [{ index: 0, tag: "textarea", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }] },
      { selector: '[contenteditable="true"]', visible: 0, rows: [] },
      { selector: 'input[type="text"]', visible: 0, rows: [] },
    ],
    composerContext: null,
    sendNearby: [sendButton("send")],
    sendTotal: 1,
    sendMatches: {},
    answers: {},
    semanticCounts: { sendExact: 0, sendGeneric: 0, submitGeneric: 0, stopGeneric: 0, attachGeneric: 0, uploadGeneric: 0, fileGeneric: 0, voiceGeneric: 0, microphoneGeneric: 0 },
    disclosure: { pageTextRead: false, inputValuesRead: false, cookiesRead: false, storageRead: false, conversationTitlesRead: false, accountNameRead: false, acted: false },
    ...overrides,
  };
}

function answerRegionsFamilies(counts, texts = {}) {
  const keys = ["data-message-role-assistant", "data-role-assistant", "ds-markdown", "assistant-class"];
  const families = keys.map((selectorKey) => ({
    selectorKey,
    visibleCount: Number(counts[selectorKey]) || 0,
    latestTextChars: String(texts[selectorKey] || "").length,
  }));
  const withText = keys.find((k) => (Number(counts[k]) || 0) > 0 && String(texts[k] || ""));
  return {
    families,
    counts: { ...counts },
    selected: withText
      ? { selectorKey: withText, visibleCount: Number(counts[withText]), textChars: String(texts[withText]).length, answerText: String(texts[withText]) }
      : null,
    totalVisible: keys.reduce((s, k) => s + (Number(counts[k]) || 0), 0),
  };
}

function answerRegionsEmpty() {
  return answerRegionsFamilies({
    "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 0, "assistant-class": 0,
  });
}

// Rig mirrors the production live shape: the initial click moves the
// conversation URL (new thread); every later click keeps the SAME URL and
// reports inputCleared:false, exactly as the production worker hard-codes.
// The first vicinity read after the second click is the post-click dispatch
// confirmation.
async function testRig({ confirmationVicinity, followUpRegions, includeDomInspect = true } = {}) {
  const capability = preflightBrowserCapability({
    tools: ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_click", "mcp__playwright__browser_fill_form", "mcp__playwright__browser_navigate"],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  });
  const clock = fakeClock();
  const timeline = [];
  const initialAdvice = goodAdviceJson("initial consult advice");
  const followUpAdvice = goodAdviceJson("follow-up advice");
  const oldFollowUpText = goodAdviceJson("initial consult advice");
  const regionsQueue = [
    answerRegionsEmpty(), // initial pre-submit baseline
    answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": initialAdvice }), // initial poll: new region
    ...(followUpRegions || [
      answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": oldFollowUpText }), // follow-up baseline: old answer present
      answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": oldFollowUpText }), // follow-up poll 1: old answer only
      answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 2, "assistant-class": 0 }, { "ds-markdown": followUpAdvice }), // follow-up poll 2: new region
    ]),
  ];
  let vicinityCalls = 0;
  let clickCount = 0;
  let confirmationServed = false;
  const calls = { fill: 0, click: 0, snapshot: 0 };
  const deps = {
    capability,
    authProbe: async () => ({ state: "READY", url: HOME_URL, answerRegions: 1 }),
    now: clock.now,
    sleep: clock.sleep,
    answerTimeoutMs: 5_000,
  };
  if (includeDomInspect) {
    deps.domInspect = async (opts = {}) => {
      const mode = String(opts.mode || "");
      if (mode === "composer-vicinity") {
        vicinityCalls += 1;
        if (clickCount >= 2 && !confirmationServed) {
          confirmationServed = true;
          timeline.push(`inspect:composer-vicinity#${vicinityCalls}:dispatch-confirm`);
          return { ok: true, vicinity: confirmationVicinity };
        }
        timeline.push(`inspect:composer-vicinity#${vicinityCalls}`);
        return { ok: true, vicinity: composerVicinity() };
      }
      if (mode === "deepseek-answer-regions") {
        timeline.push("inspect:deepseek-answer-regions");
        const next = regionsQueue.length ? regionsQueue.shift() : answerRegionsEmpty();
        return { ok: true, answerRegions: next };
      }
      return { ok: true, vicinity: composerVicinity() };
    };
  }
  deps.invoke = async (action, context) => {
    timeline.push(`invoke:${action}`);
    if (action === "navigate") return { ok: true, afterUrl: HOME_URL };
    if (action === "fill") {
      calls.fill += 1;
      return { ok: true, filledChars: 42 };
    }
    if (action === "click") {
      calls.click += 1;
      clickCount += 1;
      if (clickCount === 1) {
        // Initial consultation: a new conversation is created, the URL moves.
        return { ok: true, beforeUrl: HOME_URL, afterUrl: CONV_URL, inputCleared: false };
      }
      // Follow-up in the SAME conversation: URL unchanged, worker reports
      // inputCleared:false (production worker hard-code). This is the exact
      // live shape that failed dispatch-verify before the fix.
      return { ok: true, beforeUrl: CONV_URL, afterUrl: CONV_URL, inputCleared: false };
    }
    if (action === "snapshot") {
      calls.snapshot += 1;
      return { ok: true, result: { answer: "" } };
    }
    return { ok: true };
  };
  const adapter = createDeepSeekWebAdapter(deps);
  const session = await adapter.startSession({});
  assert.equal(session.state, "ready");
  return { adapter, session, timeline, calls, initialAdvice, followUpAdvice };
}

// --- 1: consult succeeds, session stays READY --------------------------------

test("V16.3 follow-up dispatch 1 initial consult succeeds and session stays reusable", async () => {
  const { adapter, session, calls } = await testRig({
    confirmationVicinity: composerVicinity({ sendNearby: [sendButton("stop")] }),
  });
  const result = await adapter.consult(session, { rendered: "initial consult prompt" }, { requestId: "fu-dv-initial" });
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("initial consult advice"));
  assert.equal(result.submitAttempts, 1);
  assert.equal(calls.fill, 1);
  assert.equal(calls.click, 1);
  assert.equal(session.state, "ready", "session must remain READY after the initial consultation");
});

// --- 2: stop-signal confirms a same-session follow-up dispatch ---------------

test("V16.3 follow-up dispatch 2 stop control confirms same-session follow-up with one click", async () => {
  const { adapter, session, timeline, calls, followUpAdvice } = await testRig({
    // Post-click vicinity: streaming Stop control visible, answer counts
    // UNCHANGED vs baseline -- the stop signal alone must confirm.
    confirmationVicinity: composerVicinity({
      sendNearby: [sendButton("stop")],
      answers: { "ds-markdown": 1 },
    }),
  });
  const initial = await adapter.consult(session, { rendered: "initial consult prompt" }, { requestId: "fu-dv-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const result = await adapter.followUp(
    session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "fu-dv-followup" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("follow-up advice"), "the NEW answer must be returned, never the old one");
  assert.equal(calls.fill, 2, "exactly one fill per round trip");
  assert.equal(calls.click, 2, "exactly one click per round trip: no second click, no retry");
  assert.equal(result.submitAttempts, 1);
  assert.equal(result.dispatchConfirmation?.confirmed, true);
  assert.equal(result.dispatchConfirmation?.reason, "stop-control-visible-post-submit");
  assert.equal(result.dispatchConfirmation?.stopVisible, true);
  assert.equal(result.dispatchConfirmation?.answerGrew, false);
  assert.equal(result.dispatchConfirmation?.probes, 1, "immediate stop confirms on probe 1 with no sleep");
  assert.equal(result.dispatchConfirmation?.elapsedMs, 0);
  assert.equal(session.state, "ready", "session must stay READY after the follow-up");
  void followUpAdvice;
});

// --- 3: confirmation precedes answer polling ---------------------------------

test("V16.3 follow-up dispatch 3 answer polling begins only after dispatch is verified", async () => {
  const { adapter, session, timeline } = await testRig({
    confirmationVicinity: composerVicinity({ sendNearby: [sendButton("stop")] }),
  });
  await adapter.consult(session, { rendered: "initial consult prompt" }, { requestId: "fu-dv-initial" });
  const mark = timeline.length;
  await adapter.followUp(
    session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "fu-dv-followup" },
  );
  const tail = timeline.slice(mark);
  const clickPos = tail.indexOf("invoke:click");
  assert.ok(clickPos >= 0, `expected a follow-up click, got ${JSON.stringify(tail)}`);
  // Only post-click reads matter: the pre-submit baseline read legitimately
  // precedes the click. After the click, confirmation must precede the first
  // answer poll, and no second click may appear anywhere.
  const afterClick = tail.slice(clickPos + 1);
  const confirmRel = afterClick.findIndex((entry) => entry.endsWith(":dispatch-confirm"));
  const firstPollRel = afterClick.indexOf("inspect:deepseek-answer-regions");
  assert.ok(confirmRel >= 0 && firstPollRel >= 0, `expected confirm+poll after click, got ${JSON.stringify(afterClick)}`);
  assert.ok(confirmRel < firstPollRel, "no answer-region poll may precede dispatch confirmation");
  assert.equal(tail.filter((entry) => entry === "invoke:click").length, 1, "no second click anywhere after the follow-up click");
});

// --- 4: answer growth confirms without a stop token ---------------------------

test("V16.3 follow-up dispatch 4 answer-region growth confirms dispatch without a stop token", async () => {
  const { adapter, session, calls } = await testRig({
    // Post-click vicinity: no stop control, but a second assistant region is
    // already streaming (baseline held exactly one).
    confirmationVicinity: composerVicinity({
      sendNearby: [sendButton("send")],
      answers: { "ds-markdown": 2 },
    }),
  });
  const initial = await adapter.consult(session, { rendered: "initial consult prompt" }, { requestId: "fu-dv-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const result = await adapter.followUp(
    session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "fu-dv-followup" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.equal(calls.click, 2, "still exactly one click per round trip");
  assert.equal(result.dispatchConfirmation?.confirmed, true);
  assert.equal(result.dispatchConfirmation?.reason, "answer-region-grew-post-submit");
  assert.equal(result.dispatchConfirmation?.stopVisible, false);
  assert.equal(result.dispatchConfirmation?.answerGrew, true);
  assert.equal(result.dispatchConfirmation?.probes, 1, "immediate growth confirms on probe 1 with no sleep");
});

// --- 5: unconfirmed dispatch keeps the exact failure and never polls ---------

test("V16.3 follow-up dispatch 5 unconfirmed follow-up keeps dispatch-verify and never polls answers", async () => {
  const { adapter, session, timeline, calls } = await testRig({
    // Post-click vicinity: send control idle, answer counts UNCHANGED vs the
    // pre-submit baseline -- no positive dispatch signal exists.
    confirmationVicinity: composerVicinity({
      sendNearby: [sendButton("send")],
      answers: { "ds-markdown": 1 },
    }),
  });
  const initial = await adapter.consult(session, { rendered: "initial consult prompt" }, { requestId: "fu-dv-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const mark = timeline.length;
  const result = await adapter.followUp(
    session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "fu-dv-followup" },
  );
  assert.equal(result.ok, false);
  assert.match(String(result.failure), /deepseek-ui-selector-changed:dispatch-verify:submit-unverified/);
  assert.equal(result.failureStage, DEEPSEEK_FAILURE_STAGE.DISPATCH_VERIFY);
  assert.equal(calls.click, 2, "the failed follow-up still clicked exactly once: no retry");
  const tail = timeline.slice(mark);
  assert.equal(
    tail.filter((entry) => entry === "inspect:deepseek-answer-regions").length,
    1,
    `only the pre-submit baseline read may run; answer polling must never begin, got ${JSON.stringify(tail)}`,
  );
});

// --- 6: unit shape of the confirmation helper ---------------------------------

test("V16.3 follow-up dispatch 6 confirmation helper is read-only and bounded", async () => {
  const stopClock = fakeClock();
  const stop = await confirmFollowUpDispatch({
    deps: {
      now: stopClock.now,
      sleep: stopClock.sleep,
      domInspect: async () => ({ ok: true, vicinity: composerVicinity({ sendNearby: [sendButton("stop")] }) }),
    },
    baseline: { dataMessageRoleAssistant: 0, dataRoleAssistant: 0, dsMarkdown: 1, assistantClass: 0 },
  });
  assert.deepEqual(stop, { confirmed: true, reason: "stop-control-visible-post-submit", stopVisible: true, answerGrew: false, probes: 1, elapsedMs: 0 });

  const unbound = await confirmFollowUpDispatch({ deps: {}, baseline: null });
  assert.deepEqual(unbound, { confirmed: false, reason: "no-dispatch-confirmation-bound", stopVisible: false, answerGrew: false, probes: 0, elapsedMs: unbound.elapsedMs });
  assert.equal(unbound.probes, 0, "no lane bound means zero probes");

  const quietClock = fakeClock();
  let inspectedModes = 0;
  const quiet = await confirmFollowUpDispatch({
    deps: {
      now: quietClock.now,
      sleep: quietClock.sleep,
      domInspect: async (opts = {}) => {
        inspectedModes += 1;
        assert.equal(String(opts.mode), "composer-vicinity");
        return { ok: true, vicinity: composerVicinity({ sendNearby: [sendButton("send")], answers: { "ds-markdown": 1 } }) };
      },
    },
    baseline: { dataMessageRoleAssistant: 0, dataRoleAssistant: 0, dsMarkdown: 1, assistantClass: 0 },
  });
  assert.deepEqual(quiet, { confirmed: false, reason: "no-post-submit-dispatch-signal", stopVisible: false, answerGrew: false, probes: 5, elapsedMs: 2000 });
  assert.equal(inspectedModes, 5, "an unconfirmed window exhausts the bounded probe budget, nothing more");
});

// --- 7: zero-retry external-side-effect policy is unchanged --------------------

test("V16.3 follow-up dispatch 7 zero-retry submit policy is unchanged", async () => {
  // The submit click runs with provenExternalSideEffect (adapter passes
  // externalSideEffect:true), which promotes the taxonomy to
  // external-side-effect with retries structurally disabled.
  const submitClick = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(submitClick.actionClass, "external-side-effect");
  assert.equal(submitClick.retryAllowed, false);
  assert.equal(submitClick.maxRetries, 0);
  const noReplay = browserRetryDecision({
    taxonomy: submitClick,
    failureKind: "verification-failed",
    message: "dispatch-verify failed",
    attempt: 1,
  });
  assert.equal(noReplay.retry, false, "an unverified submit must never be replayed");
  assert.equal(noReplay.maxAttempts, 1);

  // The fix adds no retry path: the adapter source still contains exactly one
  // click site in the submit flow and no retry loop around it.
  const source = await readFile(path.join(root, "lib", "deepseek-web-adapter.mjs"), "utf8");
  const submitBlock = source.slice(source.indexOf("async function sendPrompt"), source.indexOf("async function waitForAnswer"));
  assert.ok(submitBlock.includes('runAction("click"'), "the single submit click site still exists");
  assert.ok(!/for\s*\(\s*[^;]*submitAttempt|while\s*\([^)]*submitAttempt|attempt\s*<\s*maxSubmit/i.test(submitBlock), "no submit retry loop exists");
  assert.ok(!submitBlock.includes("dispatchConfirmation") || submitBlock.includes("confirmFollowUpDispatch"), "confirmation is the only dispatch addition");
  const retrySource = await readFile(path.join(root, "lib", "browser-retry-policy.mjs"), "utf8");
  assert.ok(!retrySource.includes("dispatch-verify") && !retrySource.includes("confirmFollowUpDispatch"), "retry policy untouched by the fix");
});
