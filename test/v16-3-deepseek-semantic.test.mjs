// V16.3 DeepSeek accessibility-semantic Send resolution.
//
// REAL EVIDENCE: post-fill structural send is 2 identical 34x34 enabled
// div[role=button] controls with no aria/control/testid distinction. The
// structural cascade correctly fails closed. This file proves the
// accessibility-semantic layer (Playwright getByRole counts, numbers only)
// is consulted POST-FILL before structural fallback, and that ambiguity
// anywhere still fails closed before any click.
//
// Deterministic. No browser, no network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_SEMANTIC_COUNT_KEYS,
  resolveDeepSeekTarget,
  sanitizeComposerVicinity,
  sanitizeSemanticCounts,
} from "../lib/deepseek-locators.mjs";
import {
  DEEPSEEK_FAILURE_STAGE,
  DEEPSEEK_SMOKE_STATUS,
  DEEPSEEK_WEB_FAILURE,
  classifyDeepSeekSmokeStatus,
} from "../lib/deepseek-web-adapter.mjs";
import {
  AUTH_PROBE_STATE,
  AUTH_SETTLE_LIMIT,
  classifyAuthState,
  waitForAuthenticatedPage,
} from "../lib/browser-profile.mjs";
import { workerModePlan, WORKER_MODE } from "../lib/browser-worker-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function composerFamily(selector, visible) {
  return {
    selector,
    visible,
    rows: visible > 0
      ? [{ index: 0, tag: "textarea", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }]
      : [],
  };
}

function semanticCounts(overrides = {}) {
  return {
    sendExact: 0,
    sendGeneric: 0,
    submitGeneric: 0,
    stopGeneric: 0,
    attachGeneric: 0,
    uploadGeneric: 0,
    fileGeneric: 0,
    voiceGeneric: 0,
    microphoneGeneric: 0,
    ...overrides,
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
    semanticCounts: semanticCounts(),
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
    ariaHasPopup: false, ariaExpanded: false, ariaControlsPresent: false,
    containsFileInput: false, insideLabel: false, dataStatePresent: false,
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

// --- 1-5: semantic resolution policy ------------------------------------------

test("V16.3 semantic 1 Send count 1 => semantic Send selected", () => {
  const inspection = vicinity({
    sendNearby: [sendButton({ distance: 1 }), sendButton({ distance: 3 })],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
    semanticCounts: semanticCounts({ sendExact: 1, sendGeneric: 1 }),
  });
  const send = resolveDeepSeekTarget("send", inspection);
  assert.equal(send.ok, true, "exact semantic uniqueness must resolve even when structural is 2");
  assert.equal(send.strategy, "role-and-accessible-name");
  assert.match(send.reason, /semantic-send-exact-resolves/);
});

test("V16.3 semantic 2 Send count 2 => fail closed", () => {
  const inspection = vicinity({
    sendNearby: [sendButton(), sendButton()],
    sendTotal: 2,
    sendMatches: {},
    semanticCounts: semanticCounts({ sendExact: 2, sendGeneric: 2 }),
  });
  const send = resolveDeepSeekTarget("send", inspection);
  assert.equal(send.ok, false, "two semantic Sends must never pick first");
  assert.match(send.reason, /ambiguous-send:semantic/);
  assert.equal(send.target, null);
});

test("V16.3 semantic 3 count 0 + structural unique => structural selected", () => {
  const inspection = vicinity({
    sendNearby: [sendButton({ disabled: true }), sendButton({ disabled: true, distance: 2 })],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 1, 'div:has(> textarea) ~ div [role="button"]': 0 },
    semanticCounts: semanticCounts(),
  });
  const send = resolveDeepSeekTarget("send", inspection);
  assert.equal(send.ok, true);
  assert.match(send.reason, /measured-send-resolves:.*count-1/);
});

test("V16.3 semantic 4 count 0 + structural 2 => fail closed", () => {
  const inspection = vicinity({
    sendNearby: [sendButton({ distance: 1 }), sendButton({ distance: 3 })],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
    semanticCounts: semanticCounts(),
  });
  const send = resolveDeepSeekTarget("send", inspection);
  assert.equal(send.ok, false);
  assert.match(send.reason, /ambiguous-send/);
});

test("V16.3 semantic 5 attach=1 and send=1 => Send selected", () => {
  const inspection = vicinity({
    sendNearby: [sendButton(), sendButton()],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
    semanticCounts: semanticCounts({ sendExact: 1, sendGeneric: 1, attachGeneric: 1 }),
  });
  const send = resolveDeepSeekTarget("send", inspection);
  assert.equal(send.ok, true, "an attach control must not override a unique Send");
  assert.match(send.reason, /semantic-send-exact-resolves/);
});

// --- 6-7: boundary safety ------------------------------------------------------

test("V16.3 semantic 6 no arbitrary accessible name crosses boundary", () => {
  const sanitized = sanitizeSemanticCounts({
    sendExact: 1, sendGeneric: 1, submitGeneric: 0,
    arbitraryName: "Ada Lovelace", rawTree: [{ name: "Send secret" }], pageText: "hello",
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [...DEEPSEEK_SEMANTIC_COUNT_KEYS].sort());
  assert.ok(!JSON.stringify(sanitized).includes("Ada"));
  const vic = sanitizeComposerVicinity({
    url: "https://chat.deepseek.com/",
    composers: [], sendNearby: [], sendTotal: 0, sendMatches: {}, answers: {},
    semanticCounts: { sendExact: 2, sendGeneric: 2, evil: "Q3 revenue" },
  });
  assert.equal(vic.semanticCounts.sendExact, 2);
  assert.ok(!JSON.stringify(vic).includes("Q3"));
  assert.ok(!("evil" in vic.semanticCounts));
});

test("V16.3 semantic 7 accessibility diagnostic is read-only", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const start = worker.indexOf("async function measureSemanticCounts()");
  assert.ok(start >= 0, "semantic counting must live in a dedicated read-only helper");
  const block = worker.slice(start, worker.indexOf("async function snapshotElements"));
  assert.ok(block.includes(".count()"), "semantic measurement uses count() only");
  for (const forbidden of [".click(", ".fill(", ".type(", ".press(", "form.submit", "dispatchEvent", "document.cookie", "localStorage", "inputValue"]) {
    assert.ok(!block.includes(forbidden), `semantic helper must not contain ${forbidden}`);
  }
  const { composerVicinityScript } = await import("../lib/deepseek-locators.mjs");
  const script = composerVicinityScript({});
  const code = script.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["document.cookie", "localStorage", "sessionStorage", ".value", "inputValue"]) {
    assert.ok(!code.includes(forbidden));
  }
});

// --- 8-12: diagnostic order and side-effect freedom -----------------------------

test("V16.3 semantic 8 diagnostic fill exactly once", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const fills = block.match(/invoke\s*\(\s*"fill"/g) || [];
  assert.equal(fills.length, 2, "one synthetic fill + one clear");
  assert.equal((block.match(/UES_LOCATOR_PROBE/g) || []).length, 1);
});

test("V16.3 semantic 9 post-fill semantic inspection happens after fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const iFill = block.indexOf('invoke("fill"');
  assert.ok(iFill >= 0);
  // Semantic counts are measured by the post-fill inspection (worker-side via
  // the accessible-name engine) and consumed by the post-fill send decision.
  assert.ok(block.includes("semanticCounts") || block.includes("semanticSendExactCount"), "diagnostic must surface semantic counts");
  const iSemantic = block.indexOf("semanticSendExactCount");
  const iPostSend = block.indexOf("postFillSend = resolveDeepSeekTarget");
  assert.ok(iSemantic >= 0 && iPostSend >= 0);
  assert.ok(iFill < iPostSend, "send decision (semantic + structural) happens AFTER the fill");
  assert.ok(block.includes("POST-FILL ACCESSIBILITY SEMANTICS"), "diagnostic prints post-fill semantics");
});

test("V16.3 semantic 10 clear always happens", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const iPostSend = block.indexOf("postFillSend = resolveDeepSeekTarget");
  const iClear = block.indexOf('value: ""');
  assert.ok(iPostSend >= 0 && iClear >= 0 && iPostSend < iClear);
});

test("V16.3 semantic 11 diagnostic click count = 0", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.equal((block.match(/invoke\s*\(\s*"click"/g) || []).length, 0);
  assert.ok(block.includes("sendClicked: false"));
});

test("V16.3 semantic 12 diagnostic submitAttempts = 0", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.ok(block.includes("submitAttempts"));
  assert.ok(block.includes("const submitAttempts = 0"));
});

// --- 13-15: worker uniqueness guard ---------------------------------------------

test("V16.3 semantic 13 worker role target count >1 refuses before click", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  assert.ok(worker.includes("ambiguous role target"), "role ambiguity must refuse");
});

test("V16.3 semantic 14 worker CSS count >1 refuses before click", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  assert.ok(worker.includes("ambiguous css target"), "CSS ambiguity must refuse");
  assert.ok(worker.includes("css target not found"), "CSS count 0 must fail, not click");
  assert.ok(worker.includes("role target not found"), "role count 0 must fail, not click");
});

test("V16.3 semantic 15 .first() only after uniqueness proof", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const guard = worker.indexOf("async function resolveTarget");
  assert.ok(guard >= 0);
  const block = worker.slice(guard, worker.indexOf("async function snapshotElements"));
  // Each branch (role and CSS) guards count 0 and count >1 before .first().
  for (const marker of ["if (target.role && target.name)", "if (target.selector)"]) {
    const start = block.indexOf(marker);
    assert.ok(start >= 0, marker);
    const nextBranch = marker.includes("role")
      ? block.indexOf("if (target.selector)", start)
      : block.length;
    const branch = block.slice(start, nextBranch);
    const iZero = branch.indexOf("count === 0");
    const iAmbiguous = branch.indexOf("count > 1");
    const iFirst = branch.indexOf(".first()");
    assert.ok(iZero >= 0 && iAmbiguous >= 0 && iFirst >= 0, `${marker} must guard and resolve`);
    assert.ok(iZero < iFirst && iAmbiguous < iFirst, `${marker}: .first() must come AFTER both count guards`);
  }
});

// --- 16-18: adapter discipline ----------------------------------------------------

test("V16.3 semantic 16 live adapter still fills once", async () => {
  const calls = [];
  const inspection = vicinity({
    sendNearby: [sendButton()],
    sendTotal: 1,
    sendMatches: {},
    semanticCounts: semanticCounts({ sendExact: 1, sendGeneric: 1 }),
  });
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    domInspect: async () => ({ ok: true, vicinity: inspection }),
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
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "sem-16" });
  assert.equal(result.ok, true);
  assert.equal(result.fillAttempts, 1);
  assert.equal(calls.filter((a) => a === "fill").length, 1);
});

test("V16.3 semantic 17 live submit at most once", async () => {
  let sends = 0;
  const inspection = vicinity({
    sendNearby: [sendButton()],
    sendTotal: 1,
    semanticCounts: semanticCounts({ sendExact: 1, sendGeneric: 1 }),
  });
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    domInspect: async () => ({ ok: true, vicinity: inspection }),
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
  const first = await adapter.consult(session, { rendered: "p" }, { requestId: "sem-17" });
  assert.equal(first.ok, true);
  assert.equal(first.submitAttempts, 1);
  assert.equal(sends, 1);
  const replay = await adapter.consult(session, { rendered: "p" }, { requestId: "sem-17" });
  assert.equal(replay.ok, false);
  assert.equal(sends, 1);
});

test("V16.3 semantic 18 external-side-effect retry remains 0", async () => {
  const { classifyBrowserAction } = await import("../lib/browser-action-taxonomy.mjs");
  const click = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  assert.equal(click.requiresExplicitApproval, true);
});

// --- 19-20: untouched verified behavior ------------------------------------------

test("V16.3 semantic 19 auth/history/hydration unchanged", async () => {
  const { AUTH_SETTLE_LIMIT } = await import("../lib/browser-profile.mjs");
  assert.equal(AUTH_SETTLE_LIMIT.maxAttempts, 5);
  assert.equal(AUTH_SETTLE_LIMIT.intervalMs, 1000);
  assert.equal(AUTH_SETTLE_LIMIT.overallTimeoutMs, 6000);
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
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" });
  const live = workerModePlan({ live: true, profile: "deepseek-web" });
  assert.equal(auth.persistentProfileName, live.persistentProfileName);
  let calls = 0;
  const worker = {
    authProbe: async () => {
      calls += 1;
      return calls === 1
        ? { state: "UNKNOWN", reason: "x", url: "https://chat.deepseek.com/", transportAlive: true }
        : { state: "READY", reason: "y", url: "https://chat.deepseek.com/", transportAlive: true };
    },
    isAlive: () => true,
    onClose: () => () => {},
  };
  const settled = await waitForAuthenticatedPage(worker, { sleep: async () => {} });
  assert.equal(settled.state, "READY");
  assert.equal(settled.attempts, 2);
});

test("V16.3 semantic 20 status mapping unchanged", () => {
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED }),
    "UI_CHANGED",
  );
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }),
    "NEEDS_AUTH",
  );
  assert.equal(DEEPSEEK_SMOKE_STATUS.UI_CHANGED, "UI_CHANGED");
  assert.equal(DEEPSEEK_SMOKE_STATUS.NEEDS_AUTH, "NEEDS_AUTH");
});
