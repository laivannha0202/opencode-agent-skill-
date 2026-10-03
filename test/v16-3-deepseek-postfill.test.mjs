// V16.3 DeepSeek post-fill send resolution + smoke status correction.
//
// REAL NEW EVIDENCE (live run):
//   status NEEDS_AUTH with reason deepseek-ui-selector-changed, 2 probes /
//   1130ms auth settle READY. Auth was NOT the failure: the settle proved READY.
//   Two bugs: (1) the live smoke mapped any unavailable/auth-substring reason
//   to NEEDS_AUTH, hiding UI drift; (2) --locator-diagnose resolved send from
//   stale pre-fill evidence while production fills before resolving send.
//
// This file is deterministic. No browser, no network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_ANSWER_CANDIDATES,
  DEEPSEEK_COMPOSER_CANDIDATES,
  disambiguateSendFromNearby,
  resolveDeepSeekTarget,
} from "../lib/deepseek-locators.mjs";
import {
  AUTH_PROBE_STATE,
  AUTH_SETTLE_LIMIT,
  classifyAuthState,
  waitForAuthenticatedPage,
} from "../lib/browser-profile.mjs";
import {
  DEEPSEEK_FAILURE_STAGE,
  DEEPSEEK_SMOKE_STATUS,
  DEEPSEEK_WEB_FAILURE,
  classifyDeepSeekSmokeStatus,
  createDeepSeekCounters,
  parseDeepSeekFailureStage,
} from "../lib/deepseek-web-adapter.mjs";
import { workerModePlan, WORKER_MODE } from "../lib/browser-worker-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function composerFamily(selector, visible) {
  return {
    selector,
    visible,
    rows: visible > 0
      ? [{ index: 0, tag: selector === "textarea" ? "textarea" : "div", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }]
      : [],
  };
}

function vicinity(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-composer-vicinity",
    url: "https://chat.deepseek.com/",
    composers: [
      composerFamily("textarea", 1),
      composerFamily('[contenteditable="true"]', 0),
      composerFamily('input[type="text"]', 0),
    ],
    composerContext: null,
    sendNearby: [],
    sendTotal: 0,
    sendMatches: {},
    answers: {},
    disclosure: {
      pageTextRead: false, inputValuesRead: false, cookiesRead: false,
      storageRead: false, conversationTitlesRead: false, accountNameRead: false, acted: false,
    },
    ...overrides,
  };
}

function sendButton(overrides = {}) {
  return {
    index: 0, tag: "div", ariaLabel: { present: false, generic: null },
    testId: null, disabled: false, hasNameAttr: false, role: "button", type: null,
    controlName: { present: false, generic: null }, hasSvg: true, childCount: 2,
    box: { w: 34, h: 34 }, tabIndex: 0, distance: 1, afterComposer: true,
    ...overrides,
  };
}

async function testAdapter(overrides = {}) {
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs");
  const { preflightBrowserCapability } = await import("../lib/browser-capability.mjs");
  const capability = preflightBrowserCapability({
    tools: [
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_navigate",
    ],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  });
  return createDeepSeekWebAdapter({ capability, ...overrides });
}

function adviceJson(summary) {
  return JSON.stringify({
    summary, hypotheses: [], recommendedApproach: [], filesToInspect: [],
    risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.5,
  });
}

// --- 1-2: status classification ---------------------------------------------

test("V16.3 postfill 1 UI_CHANGED reason reports UI_CHANGED, never NEEDS_AUTH", () => {
  const fromFailure = classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: "deepseek-ui-selector-changed" });
  assert.equal(fromFailure, DEEPSEEK_SMOKE_STATUS.UI_CHANGED);
  assert.notEqual(fromFailure, DEEPSEEK_SMOKE_STATUS.NEEDS_AUTH);
  // With a stage suffix (the new safe evidence) the mapping still holds.
  const staged = classifyDeepSeekSmokeStatus({
    outcome: "unavailable",
    reason: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL}:ambiguous-send`,
  });
  assert.equal(staged, "UI_CHANGED");
  // A bare unavailable outcome with no auth token is UNAVAILABLE, never auth.
  const bare = classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: "provider hiccup" });
  assert.equal(bare, "UNAVAILABLE");
  assert.notEqual(bare, "NEEDS_AUTH");
  // The reported live failure shape (2 probes READY, then selector drift)
  // must never read as authentication.
  const liveShape = classifyDeepSeekSmokeStatus({
    outcome: "unavailable",
    reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED,
  });
  assert.equal(liveShape, "UI_CHANGED");
});

test("V16.3 postfill 2 auth-required still reports NEEDS_AUTH", () => {
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }),
    "NEEDS_AUTH",
  );
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "fallback-local", reason: "deepseek-auth-required:session-auth" }),
    "NEEDS_AUTH",
  );
  // Timeout, no-answer and browser-unavailable stay distinct from auth.
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.TIMEOUT }),
    "TIMEOUT",
  );
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "fallback-local", reason: DEEPSEEK_WEB_FAILURE.NO_ANSWER }),
    "FAIL",
  );
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE }),
    "UNAVAILABLE",
  );
});

// --- 3-8: diagnostic order (production parity, side-effect free) --------------

test("V16.3 postfill 3 locator diagnostic resolves composer before fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const start = smoke.indexOf("if (args.locatorDiagnose)");
  const end = smoke.indexOf("// ---- preflight: observe");
  assert.ok(start >= 0 && end > start);
  const block = smoke.slice(start, end);
  const iComposer = block.indexOf('resolveDeepSeekTarget("composer"');
  const iFill = block.indexOf('invoke("fill"');
  assert.ok(iComposer >= 0 && iFill >= 0, "diagnostic must resolve composer and fill");
  assert.ok(iComposer < iFill, "composer must resolve BEFORE any fill");
});

test("V16.3 postfill 4 diagnostic fills exactly once", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const fills = block.match(/invoke\s*\(\s*"fill"/g) || [];
  // One synthetic fill + one clear. The synthetic fill happens exactly once;
  // the second fill is the clear (value "").
  assert.equal(fills.length, 2, `expected fill + clear, got ${fills.length}`);
  assert.ok(block.includes('value: "UES_LOCATOR_PROBE"'), "synthetic non-secret fill text");
  assert.ok(block.includes('value: ""'), "composer is cleared afterwards");
  // The synthetic fill text appears exactly once (fill once, never twice).
  const probes = block.match(/UES_LOCATOR_PROBE/g) || [];
  assert.equal(probes.length, 1, "synthetic probe text must be filled exactly once");
});

test("V16.3 postfill 5 POST-FILL reinspection happens after fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.ok(block.includes("POST-FILL re-inspection") || block.includes("POST-FILL reinspection") || block.includes("RE-INSPECT"), "diagnostic must document post-fill reinspection");
  const iFill = block.indexOf('invoke("fill"');
  const iPostSend = block.indexOf("postFillSend = resolveDeepSeekTarget");
  assert.ok(iFill >= 0 && iPostSend >= 0);
  assert.ok(iFill < iPostSend, "post-fill send resolution must happen AFTER the fill");
  // Two vicinity inspections: pre-fill and post-fill.
  const inspects = block.match(/domInspect\(\{ mode: "composer-vicinity"/g) || [];
  assert.ok(inspects.length >= 2, `expected pre-fill + post-fill inspections, got ${inspects.length}`);
});

test("V16.3 postfill 6 send resolution uses POST-FILL inspection, not stale pre-fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  // The send decision reads the POST-FILL vicinity variable, never the pre one.
  assert.ok(block.includes('resolveDeepSeekTarget("send", postVic.vicinity') || block.includes("resolveDeepSeekTarget(\"send\", postVic"), "send must resolve from post-fill vicinity");
  assert.ok(!block.match(/const send = resolveDeepSeekTarget\("send", vic\.vicinity\)/), "stale single-inspection send resolution must be gone");
  // Production parity: the adapter resolves send AFTER fill from a fresh read.
  const adapter = await readFile(path.join(root, "lib", "deepseek-web-adapter.mjs"), "utf8");
  const fillPos = adapter.indexOf('await runAction("fill"');
  const sendPos = adapter.indexOf("await resolveSendTarget");
  assert.ok(fillPos >= 0 && sendPos >= 0 && fillPos < sendPos, "live adapter must fill BEFORE resolving send");
  assert.ok(adapter.includes("POST-FILL resolution"), "adapter must document post-fill send resolution");
});

test("V16.3 postfill 7 composer is cleared even if send resolution fails", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  // Clear happens after the send decision, outside any send-ok gate.
  const iPostSend = block.indexOf("postFillSend = resolveDeepSeekTarget");
  const iClear = block.indexOf('value: ""');
  assert.ok(iPostSend >= 0 && iClear >= 0 && iPostSend < iClear, "clear must happen AFTER the send decision");
  assert.ok(!block.slice(iPostSend, iClear).includes("return;"), "no early return between send decision and clear");
  // Behavioural proof with a fake: ambiguous post-fill send still clears.
  const order = [];
  const pre = vicinity({ sendNearby: [sendButton()], sendTotal: 1, sendMatches: {} });
  const post = vicinity({
    sendNearby: [sendButton({ distance: 1 }), sendButton({ distance: 2 })],
    sendTotal: 2,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
  });
  let inspections = 0;
  const fakeWorker = {
    domInspect: async () => {
      inspections += 1;
      order.push(`inspect-${inspections}`);
      return { ok: true, vicinity: inspections === 1 ? pre : post };
    },
    invoke: async (action, ctx) => {
      order.push(action);
      if (action === "fill" && String(ctx?.value) === "UES_LOCATOR_PROBE") return { ok: true, filledChars: 17 };
      if (action === "fill" && String(ctx?.value) === "") return { ok: true, filledChars: 0 };
      return { ok: true };
    },
  };
  // Mirror the smoke sequence with the fakes.
  const first = await fakeWorker.domInspect({});
  const composer = resolveDeepSeekTarget("composer", first.vicinity);
  assert.equal(composer.ok, true);
  order.push("fill-probe");
  const filled = await fakeWorker.invoke("fill", { value: "UES_LOCATOR_PROBE" });
  assert.equal(filled.filledChars, 17);
  const second = await fakeWorker.domInspect({});
  const sendPost = resolveDeepSeekTarget("send", second.vicinity);
  assert.equal(sendPost.ok, false, "ambiguous post-fill send must fail");
  const cleared = await fakeWorker.invoke("fill", { value: "" });
  assert.equal(cleared.filledChars, 0, "composer cleared even after send failure");
  assert.ok(order.indexOf("fill-probe") < order.lastIndexOf("fill"), "clear happens after the send decision");
});

test("V16.3 postfill 8 diagnostic clicks zero times", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const clicks = block.match(/invoke\s*\(\s*"click"/g) || [];
  assert.equal(clicks.length, 0, "diagnostic must never click");
  assert.ok(block.includes("sendClicked: false"), "diagnostic must report sendClicked false");
  assert.ok(block.includes("submitAttempts"), "diagnostic must report bounded submitAttempts (0)");
});

// --- 9-12: post-fill send uniqueness ------------------------------------------

test("V16.3 postfill 9 post-fill send unique => LOCATOR_READY shape", () => {
  const post = vicinity({
    sendNearby: [sendButton({ ariaLabel: { present: true, generic: "send" } })],
    sendTotal: 1,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 1 },
  });
  const composer = resolveDeepSeekTarget("composer", post);
  const send = resolveDeepSeekTarget("send", post);
  assert.equal(composer.ok, true);
  assert.equal(send.ok, true);
  assert.equal(send.reason, "measured-send-resolves:send");
  // Unique structural count also resolves.
  const structural = vicinity({
    sendNearby: [sendButton({ disabled: true }), sendButton({ disabled: true, distance: 2 })],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 1, 'div:has(> textarea) ~ div [role="button"]': 0 },
  });
  const structuralSend = resolveDeepSeekTarget("send", structural);
  // Structural unique resolves OR discriminates; either way it is usable, never
  // an arbitrary first-of-many.
  assert.equal(structuralSend.ok, true);
});

test("V16.3 postfill 10 post-fill send ambiguous => UI_CHANGED before click", () => {
  const post = vicinity({
    sendNearby: [sendButton({ distance: 1 }), sendButton({ distance: 2 })],
    sendTotal: 2,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
  });
  const send = resolveDeepSeekTarget("send", post);
  assert.equal(send.ok, false, "count=2 with no discriminator must fail");
  assert.match(send.reason, /ambiguous-send/);
  assert.equal(classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED }), "UI_CHANGED");
});

test("V16.3 postfill 11 CSS send with 2 matches cannot rely on .first()", async () => {
  const post = vicinity({
    sendNearby: [sendButton({ distance: 1 }), sendButton({ distance: 2 })],
    sendTotal: 5,
    sendMatches: {
      'div:has(> textarea) + div [role="button"]': 2,
      'div:has(> textarea) ~ div [role="button"]': 2,
    },
  });
  const send = resolveDeepSeekTarget("send", post);
  assert.equal(send.ok, false, "resolver must not return an ambiguous CSS target");
  assert.equal(send.target, null, "no target may be handed to the worker for an ambiguous match");
  // The worker is the second gate: an ambiguous CSS selector throws before click.
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  assert.ok(worker.includes("ambiguous css target"), "worker must fail closed on ambiguous CSS");
  assert.ok(worker.includes("ambiguous role target"), "worker must fail closed on ambiguous role");
  // The old unsafe claim is gone.
  const locators = await readFile(path.join(root, "lib", "deepseek-locators.mjs"), "utf8");
  assert.ok(!locators.includes("post-click dispatch verification gates actual submission"), "unsafe first-of-2 claim must be gone");
});

test("V16.3 postfill 12 safe semantic discriminator can reduce 2 candidates to 1", () => {
  // Two toolbar buttons, exactly one carrying the generic send label.
  const post = vicinity({
    sendNearby: [
      sendButton({ distance: 1, ariaLabel: { present: true, generic: "send" }, disabled: false }),
      sendButton({ distance: 2, ariaLabel: { present: false, generic: null }, disabled: false }),
    ],
    sendTotal: 2,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
  });
  const send = resolveDeepSeekTarget("send", post);
  assert.equal(send.ok, true, "generic send label discriminates 2 candidates to 1");
  assert.match(send.reason, /measured-send-resolves:send/);
  // Enabled-state difference also discriminates without any label.
  const enabledDiff = vicinity({
    sendNearby: [
      sendButton({ distance: 1, disabled: false }),
      sendButton({ distance: 2, disabled: true }),
    ],
    sendTotal: 2,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
  });
  const discriminated = disambiguateSendFromNearby(enabledDiff.sendNearby);
  assert.equal(discriminated.ok, true);
  assert.match(discriminated.reason, /enabled-state-difference/);
  const resolved = resolveDeepSeekTarget("send", enabledDiff);
  assert.equal(resolved.ok, true, "enabled difference discriminates 2 candidates to 1");
  // Two semantic matches stay ambiguous (never first-of-2).
  const bothSemantic = vicinity({
    sendNearby: [
      sendButton({ ariaLabel: { present: true, generic: "send" }, disabled: false }),
      sendButton({ ariaLabel: { present: true, generic: "send" }, disabled: false }),
    ],
    sendTotal: 2,
    sendMatches: {},
  });
  assert.equal(resolveDeepSeekTarget("send", bothSemantic).ok, false);
});

// --- 13-16: adapter submit discipline -----------------------------------------

test("V16.3 postfill 13 no submit retry", async () => {
  const { classifyBrowserAction } = await import("../lib/browser-action-taxonomy.mjs");
  const click = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  let sends = 0;
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async (action) => {
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") {
        sends += 1;
        return { ok: false, error: "net::ERR_CONNECTION_RESET" };
      }
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "postfill-13" });
  assert.equal(result.ok, false);
  assert.equal(sends, 1, "one submit attempt, zero retries");
});

test("V16.3 postfill 14 live adapter fills once", async () => {
  const calls = [];
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      calls.push(action);
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      if (action === "snapshot") return { ok: true, result: { answer: adviceJson("s") } };
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "postfill-14" });
  assert.equal(result.ok, true);
  assert.equal(result.fillAttempts, 1, "adapter reports exactly one fill");
  assert.equal(calls.filter((a) => a === "fill").length, 1);
});

test("V16.3 postfill 15 live adapter resolves send after fill", async () => {
  const order = [];
  const inspection = vicinity({
    sendNearby: [sendButton({ ariaLabel: { present: true, generic: "send" } })],
    sendTotal: 1,
  });
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    domInspect: async () => { order.push("domInspect"); return { ok: true, vicinity: inspection } },
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      order.push(action);
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      if (action === "snapshot") return { ok: true, result: { answer: adviceJson("s") } };
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "postfill-15" });
  assert.equal(result.ok, true);
  const fillPos = order.indexOf("fill");
  const clickPos = order.indexOf("click");
  assert.ok(fillPos >= 0 && clickPos >= 0 && fillPos < clickPos);
  // A fresh post-fill inspection must sit BETWEEN fill and click: that is the
  // production parity the diagnostic reproduces.
  const postFillInspects = order
    .map((entry, index) => ({ entry, index }))
    .filter((row) => row.entry === "domInspect" && row.index > fillPos && row.index < clickPos);
  assert.ok(postFillInspects.length >= 1, `expected a post-fill domInspect between fill and click, got ${JSON.stringify(order)}`);
});

test("V16.3 postfill 16 live adapter submits at most once", async () => {
  let sends = 0;
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      if (action === "click") sends += 1;
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      if (action === "snapshot") return { ok: true, result: { answer: adviceJson("s") } };
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  const first = await adapter.consult(session, { rendered: "p" }, { requestId: "postfill-16" });
  assert.equal(first.ok, true);
  assert.equal(first.submitAttempts, 1);
  assert.equal(sends, 1);
  const replay = await adapter.consult(session, { rendered: "p" }, { requestId: "postfill-16" });
  assert.equal(replay.ok, false);
  assert.equal(sends, 1, "a replayed prompt must never produce a second submit");
  // A failed send still reports at most one attempt, with its stage.
  let failedSends = 0;
  const failing = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    domInspect: async () => ({
      ok: true,
      vicinity: vicinity({ sendNearby: [], sendTotal: 0, sendMatches: {} }),
    }),
    invoke: async (action) => {
      if (action === "click") failedSends += 1;
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      return { ok: true };
    },
  });
  const failingSession = await failing.startSession({});
  const failed = await failing.consult(failingSession, { rendered: "p" }, { requestId: "postfill-16b" });
  assert.equal(failed.ok, false);
  assert.equal(failedSends, 0, "no click without a resolved post-fill send");
  assert.equal(failed.failureStage, DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL);
  assert.equal(failed.submitAttempts, 0);
});

// --- 17-20: safety + untouched verified logic ----------------------------------

test("V16.3 postfill 17 no private text/values cross diagnostics", async () => {
  const { sanitizeComposerVicinity, composerVicinityScript } = await import("../lib/deepseek-locators.mjs");
  const nasty = {
    url: "https://chat.deepseek.com/?token=abc123",
    composers: [{
      selector: "textarea", visible: 1,
      rows: [{ index: 0, tag: "textarea", ariaLabel: { present: true, generic: "Ada" }, testId: "[present]", accountName: "Ada", inputValue: "hunter2" }],
    }],
    sendNearby: [{ index: 0, tag: "div", role: "button", ariaLabel: { present: true, generic: "hunter2" }, controlName: { present: true, generic: "secret" }, testId: "[present]", disabled: false }],
    sendTotal: 1, sendMatches: {}, answers: {},
  };
  const sanitized = sanitizeComposerVicinity(nasty);
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of ["Ada", "hunter2", "tok", "token=abc123", "secret"]) {
    assert.ok(!serialized.includes(forbidden), `vicinity leaked ${forbidden}`);
  }
  const script = composerVicinityScript({});
  const code = script.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["document.cookie", "localStorage", "sessionStorage", ".value", "inputValue"]) {
    assert.ok(!code.includes(forbidden));
  }
  // Stage/counter evidence carries no content either.
  const counters = createDeepSeekCounters();
  assert.deepEqual(counters, { fillAttempts: 0, submitAttempts: 0, snapshotAttempts: 0 });
  const classified = classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED });
  assert.ok(!JSON.stringify({ classified }).includes("UES_LOCATOR_PROBE"));
  assert.equal(parseDeepSeekFailureStage(`${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL}:x`), DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL);
});

test("V16.3 postfill 18 auth settle unchanged", async () => {
  assert.equal(AUTH_SETTLE_LIMIT.maxAttempts, 5);
  assert.equal(AUTH_SETTLE_LIMIT.intervalMs, 1000);
  assert.equal(AUTH_SETTLE_LIMIT.overallTimeoutMs, 6000);
  let calls = 0;
  const worker = {
    authProbe: async () => {
      calls += 1;
      return calls === 1
        ? { state: "UNKNOWN", reason: "composer-visible-but-no-session-signal", url: "https://chat.deepseek.com/", transportAlive: true }
        : { state: "READY", reason: "composer-and-history-present", url: "https://chat.deepseek.com/", transportAlive: true };
    },
    isAlive: () => true,
    onClose: () => () => {},
  };
  const settled = await waitForAuthenticatedPage(worker, { sleep: async () => {} });
  assert.equal(settled.state, "READY");
  assert.equal(settled.attempts, 2);
});

test("V16.3 postfill 19 persistent profile unchanged", () => {
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" });
  const live = workerModePlan({ live: true, profile: "deepseek-web" });
  assert.equal(auth.persistentProfileName, live.persistentProfileName);
  assert.equal(auth.profileName, live.profileName);
  assert.equal(workerModePlan({}).mode, WORKER_MODE.PREFLIGHT);
});

test("V16.3 postfill 20 previous hydration/history regressions unchanged", () => {
  const first = classifyAuthState({
    url: "https://chat.deepseek.com/", composerVisible: true,
    accountSignal: false, answerRegions: 0, historyCount: 0,
  });
  assert.equal(first.state, AUTH_PROBE_STATE.UNKNOWN);
  const second = classifyAuthState({
    url: "https://chat.deepseek.com/", composerVisible: true,
    accountSignal: false, answerRegions: 0, historyCount: 50,
  });
  assert.equal(second.state, AUTH_PROBE_STATE.READY);
  assert.equal(second.reason, "composer-and-history-present");
});
