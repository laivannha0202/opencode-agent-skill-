// V16.3 follow-up dispatch confirmation window regression.
//
// LIVE EVIDENCE (one failed run): same session reused, ready before submit,
// one fill, one click, no session-lost, confirmFollowUpDispatch ran once, and
// the single immediate post-click probe saw `stopVisible=false,
// answerGrew=false` -> `no-post-submit-dispatch-signal`. Answer polling never
// started. The DeepSeek UI streams asynchronously (Stop control / new answer
// region appear AFTER the click transport returns), so a single immediate
// read races UI hydration.
//
// FIX UNDER TEST: `confirmFollowUpDispatch` keeps exactly one Send click and
// replaces the single immediate read with a bounded READ-ONLY observation
// window (immediate first probe, 500ms re-probes, 5 probes / 3000ms hard
// timeout). Positive signals are unchanged (stop-visible, answer-grew);
// elapsed time alone never confirms; an empty window preserves the exact
// fail-closed `submit-unverified` outcome.
//
// This file is deterministic. No browser, no network, no DeepSeek, no live
// retry of Send.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_FAILURE_STAGE,
  FOLLOWUP_DISPATCH_CONFIRM_LIMIT,
  confirmFollowUpDispatch,
  createDeepSeekWebAdapter,
} from "../lib/deepseek-web-adapter.mjs";
import { preflightBrowserCapability } from "../lib/browser-capability.mjs";
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs";
import { browserRetryDecision } from "../lib/browser-retry-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOME_URL = "https://chat.deepseek.com/";
const CONV_URL = "https://chat.deepseek.com/a/fu-window-1";

function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  const sleeps = [];
  return {
    now: () => value,
    advance: (ms) => { value += ms; return value; },
    sleep: async (ms) => { const v = Number(ms) || 0; sleeps.push(v); value += v; },
    sleeps,
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

const QUIET_VICINITY = () => composerVicinity({
  sendNearby: [sendButton("send")],
  answers: { "ds-markdown": 1 },
});
const STOP_VICINITY = () => composerVicinity({
  sendNearby: [sendButton("stop")],
  answers: { "ds-markdown": 1 },
});
const GROWN_VICINITY = () => composerVicinity({
  sendNearby: [sendButton("send")],
  answers: { "ds-markdown": 2 },
});
const BASELINE = { dataMessageRoleAssistant: 0, dataRoleAssistant: 0, dsMarkdown: 1, assistantClass: 0 };

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

// Adapter rig with a scripted post-click vicinity queue: the i-th
// composer-vicinity probe after the follow-up click observes
// `postClickVicinities[i-1]` (last entry repeats). Mirrors the production
// live shape (initial click moves URL; follow-up click keeps URL,
// inputCleared:false).
async function windowRig({ postClickVicinities = [STOP_VICINITY()], followUpRegions = null } = {}) {
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
    answerRegionsEmpty(),
    answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": initialAdvice }),
    answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": oldFollowUpText }),
    ...(followUpRegions || [
      answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 1, "assistant-class": 0 }, { "ds-markdown": oldFollowUpText }),
      answerRegionsFamilies({ "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 2, "assistant-class": 0 }, { "ds-markdown": followUpAdvice }),
    ]),
  ];
  let clickCount = 0;
  let postClickProbes = 0;
  const calls = { fill: 0, click: 0, snapshot: 0 };
  const vicinityModes = [];
  const deps = {
    capability,
    authProbe: async () => ({ state: "READY", url: HOME_URL, answerRegions: 1 }),
    now: clock.now,
    sleep: clock.sleep,
    answerTimeoutMs: 5_000,
    domInspect: async (opts = {}) => {
      const mode = String(opts.mode || "");
      if (mode === "composer-vicinity") {
        vicinityModes.push(mode);
        if (clickCount >= 2) {
          postClickProbes += 1;
          const queued = postClickVicinities[Math.min(postClickProbes - 1, postClickVicinities.length - 1)];
          timeline.push(`inspect:composer-vicinity:post-click-probe#${postClickProbes}`);
          return { ok: true, vicinity: queued };
        }
        timeline.push("inspect:composer-vicinity:pre-click");
        return { ok: true, vicinity: composerVicinity() };
      }
      if (mode === "deepseek-answer-regions") {
        timeline.push("inspect:deepseek-answer-regions");
        const next = regionsQueue.length ? regionsQueue.shift() : answerRegionsEmpty();
        return { ok: true, answerRegions: next };
      }
      return { ok: true, vicinity: composerVicinity() };
    },
    invoke: async (action, context) => {
      timeline.push(`invoke:${action}`);
      if (action === "navigate") return { ok: true, afterUrl: HOME_URL };
      if (action === "fill") {
        calls.fill += 1;
        return { ok: true, filledChars: 42 };
      }
      if (action === "click") {
        calls.click += 1;
        clickCount += 1;
        if (clickCount === 1) return { ok: true, beforeUrl: HOME_URL, afterUrl: CONV_URL, inputCleared: false };
        return { ok: true, beforeUrl: CONV_URL, afterUrl: CONV_URL, inputCleared: false };
      }
      if (action === "snapshot") {
        calls.snapshot += 1;
        return { ok: true, result: { answer: "" } };
      }
      return { ok: true };
    },
  };
  const adapter = createDeepSeekWebAdapter(deps);
  const session = await adapter.startSession({});
  assert.equal(session.state, "ready");
  return { adapter, session, timeline, calls, clock, initialAdvice, followUpAdvice, getPostClickProbes: () => postClickProbes, vicinityModes };
}

// --- 0: window budget constants ------------------------------------------------

test("V16.3 dispatch window 0 bounded budget: immediate first probe, 500ms interval, 5 probes, 3s hard timeout", async () => {
  assert.deepEqual(
    { ...FOLLOWUP_DISPATCH_CONFIRM_LIMIT },
    { maxProbes: 5, intervalMs: 500, overallTimeoutMs: 3000 },
    "click-to-first-probe ~0ms (no pre-sleep), interval 500ms, max 5 read-only probes, 3000ms hard window",
  );
});

// --- 1: Stop appears on a later probe -> confirmed ------------------------------

test("V16.3 dispatch window 1 signal absent first, Stop appears later -> confirmed", async () => {
  const clock = fakeClock();
  const script = [QUIET_VICINITY(), QUIET_VICINITY(), STOP_VICINITY()];
  const modes = [];
  const res = await confirmFollowUpDispatch({
    deps: {
      now: clock.now,
      sleep: clock.sleep,
      domInspect: async (opts = {}) => {
        modes.push(String(opts.mode));
        return { ok: true, vicinity: script[Math.min(modes.length - 1, script.length - 1)] };
      },
    },
    baseline: BASELINE,
  });
  assert.equal(res.confirmed, true);
  assert.equal(res.reason, "stop-control-visible-post-submit");
  assert.equal(res.stopVisible, true);
  assert.equal(res.probes, 3, "stops at the first positive signal");
  assert.equal(res.elapsedMs, 1000, "two 500ms intervals before probe 3");
  assert.deepEqual(clock.sleeps, [500, 500], "no sleep before probe 1: click-to-first-probe is ~0ms; 500ms between probes");
  assert.ok(modes.every((m) => m === "composer-vicinity"), "every probe is a read-only vicinity inspection");
  assert.equal(modes.length, 3, "probing stops as soon as the positive signal appears");
});

// --- 2: answer growth appears later -> confirmed ---------------------------------

test("V16.3 dispatch window 2 signal absent initially, answer growth later -> confirmed", async () => {
  const clock = fakeClock();
  const script = [QUIET_VICINITY(), GROWN_VICINITY()];
  let probes = 0;
  const res = await confirmFollowUpDispatch({
    deps: {
      now: clock.now,
      sleep: clock.sleep,
      domInspect: async () => {
        probes += 1;
        return { ok: true, vicinity: script[Math.min(probes - 1, script.length - 1)] };
      },
    },
    baseline: BASELINE,
  });
  assert.equal(res.confirmed, true);
  assert.equal(res.reason, "answer-region-grew-post-submit");
  assert.equal(res.stopVisible, false);
  assert.equal(res.answerGrew, true);
  assert.equal(res.probes, 2);
  assert.equal(res.elapsedMs, 500);
  assert.deepEqual(clock.sleeps, [500]);
});

// --- 3: no signal through the whole window -> submit-unverified ------------------

test("V16.3 dispatch window 3 no signal through whole window -> submit-unverified, polling never starts", async () => {
  const rig = await windowRig({ postClickVicinities: [QUIET_VICINITY()] });
  const initial = await rig.adapter.consult(rig.session, { rendered: "initial consult prompt" }, { requestId: "w-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const mark = rig.timeline.length;
  const result = await rig.adapter.followUp(
    rig.session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "w-followup" },
  );
  assert.equal(result.ok, false);
  assert.equal(
    String(result.failure),
    "deepseek-ui-selector-changed:dispatch-verify:submit-unverified",
    "exact fail-closed outcome preserved byte-for-byte",
  );
  assert.equal(result.failureStage, DEEPSEEK_FAILURE_STAGE.DISPATCH_VERIFY);
  assert.equal(result.dispatchConfirmation?.confirmed, false);
  assert.equal(result.dispatchConfirmation?.reason, "no-post-submit-dispatch-signal");
  assert.equal(result.dispatchConfirmation?.probes, 5, "the full bounded window was observed");
  const tail = rig.timeline.slice(mark);
  assert.equal(
    tail.filter((e) => e === "inspect:deepseek-answer-regions").length,
    1,
    `only the pre-submit baseline read may run; answer polling must never begin, got ${JSON.stringify(tail)}`,
  );
});

// --- 4: exactly one click total ---------------------------------------------------

test("V16.3 dispatch window 4 delayed Stop confirms with exactly one Send click", async () => {
  const rig = await windowRig({ postClickVicinities: [QUIET_VICINITY(), QUIET_VICINITY(), STOP_VICINITY()] });
  const initial = await rig.adapter.consult(rig.session, { rendered: "initial consult prompt" }, { requestId: "w-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const result = await rig.adapter.followUp(
    rig.session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "w-followup" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  assert.ok(String(result.answer).includes("follow-up advice"), "the NEW answer must be returned, never the old one");
  assert.equal(rig.calls.click, 2, "exactly one click per round trip across the whole run: no second click, no retry");
  assert.equal(result.submitAttempts, 1);
  assert.equal(rig.calls.fill, 2, "exactly one fill per round trip");
  assert.equal(result.dispatchConfirmation?.confirmed, true);
  assert.equal(result.dispatchConfirmation?.reason, "stop-control-visible-post-submit");
  assert.equal(result.dispatchConfirmation?.probes, 3, "late signal still confirms inside the window");
  // Post-click vicinity reads: 3 confirmation probes (authoritative helper
  // count above) + 1 pre-existing answer-target resolve read. The helper
  // stopped at its first positive signal; the 4th read is answer-phase setup.
  assert.equal(rig.getPostClickProbes(), 4, "3 confirmation probes + 1 answer-target resolve read");
});

// --- 5: no browser retry for the external side effect ------------------------------

test("V16.3 dispatch window 5 no browser retry decision for the external side effect", async () => {
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

  // Structural proof: the adapter still contains exactly one click site and no
  // submit retry loop; the window adds reads only.
  const source = await readFile(path.join(root, "lib", "deepseek-web-adapter.mjs"), "utf8");
  assert.equal(
    source.split('runAction("click"').length - 1,
    1,
    "proof the submit click count remains exactly one",
  );
  const submitBlock = source.slice(source.indexOf("async function sendPrompt"), source.indexOf("async function waitForAnswer"));
  assert.ok(!/for\s*\(\s*[^;]*submitAttempt|while\s*\([^)]*submitAttempt|attempt\s*<\s*maxSubmit/i.test(submitBlock), "no submit retry loop exists");
  const retrySource = await readFile(path.join(root, "lib", "browser-retry-policy.mjs"), "utf8");
  assert.ok(!retrySource.includes("dispatch-verify") && !retrySource.includes("confirmFollowUpDispatch"), "retry policy untouched");
});

// --- 6: confirmation probes are read-only --------------------------------------------

test("V16.3 dispatch window 6 confirmation probes are read-only", async () => {
  const rig = await windowRig({ postClickVicinities: [QUIET_VICINITY(), STOP_VICINITY()] });
  const initial = await rig.adapter.consult(rig.session, { rendered: "initial consult prompt" }, { requestId: "w-initial" });
  assert.equal(initial.ok, true, JSON.stringify(initial.failure || initial));
  const fillsBefore = rig.calls.fill;
  const clicksBefore = rig.calls.click;
  const mark = rig.timeline.length;
  const result = await rig.adapter.followUp(
    rig.session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "w-followup" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  // The follow-up itself is one fill + one click; the confirmation window adds
  // no external action on top of that single submit.
  assert.equal(rig.calls.fill - fillsBefore, 1, "no fill inside the confirmation window");
  assert.equal(rig.calls.click - clicksBefore, 1, "no click inside the confirmation window: the submit click count stays one");
  const tail = rig.timeline.slice(mark);
  const clickPos = tail.indexOf("invoke:click");
  assert.ok(clickPos >= 0);
  const betweenClickAndPoll = tail.slice(clickPos + 1);
  const firstPoll = betweenClickAndPoll.indexOf("inspect:deepseek-answer-regions");
  const windowSlice = firstPoll >= 0 ? betweenClickAndPoll.slice(0, firstPoll) : betweenClickAndPoll;
  assert.ok(!windowSlice.some((e) => e.startsWith("invoke:")), `no browser action inside the window, got ${JSON.stringify(windowSlice)}`);
  assert.ok(windowSlice.length > 0 && windowSlice.every((e) => e.startsWith("inspect:composer-vicinity:post-click-probe")), "window holds only read-only vicinity probes");
});

// --- 7: answer polling begins only after dispatch confirmation --------------------------

test("V16.3 dispatch window 7 answer polling begins only after dispatch confirmation", async () => {
  const rig = await windowRig({ postClickVicinities: [QUIET_VICINITY(), QUIET_VICINITY(), STOP_VICINITY()] });
  await rig.adapter.consult(rig.session, { rendered: "initial consult prompt" }, { requestId: "w-initial" });
  const mark = rig.timeline.length;
  const result = await rig.adapter.followUp(
    rig.session,
    { sections: { changed: ["new failing test evidence"] }, chars: 32 },
    { requestId: "w-followup" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failure || result));
  const tail = rig.timeline.slice(mark);
  const clickPos = tail.indexOf("invoke:click");
  assert.ok(clickPos >= 0, `expected a follow-up click, got ${JSON.stringify(tail)}`);
  const afterClick = tail.slice(clickPos + 1);
  const probeIdx = afterClick
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.startsWith("inspect:composer-vicinity:post-click-probe"))
    .map(({ i }) => i);
  // 3 bounded confirmation probes (authoritative: dispatchConfirmation.probes)
  // + 1 pre-existing answer-target resolve read, all before any answer poll.
  assert.equal(result.dispatchConfirmation?.probes, 3, "confirmation stopped at its first positive signal");
  assert.equal(probeIdx.length, 4, `expected 3 confirmation probes + 1 answer-resolve read, got ${JSON.stringify(afterClick)}`);
  const firstPollRel = afterClick.indexOf("inspect:deepseek-answer-regions");
  assert.ok(firstPollRel >= 0, `expected answer polling, got ${JSON.stringify(afterClick)}`);
  assert.ok(
    probeIdx[probeIdx.length - 1] < firstPollRel,
    "no answer-region poll may precede dispatch confirmation",
  );
  assert.equal(tail.filter((e) => e === "invoke:click").length, 1, "no second click anywhere after the follow-up click");
});
