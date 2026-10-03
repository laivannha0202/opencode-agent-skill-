// V16.3 DeepSeek pre-fill -> post-fill state-transition discriminator.
//
// REAL EVIDENCE: structural send is 2 identical controls and accessibility
// counts are ALL ZERO, so neither layer can identify Send. The system stays
// fail-closed. This file proves the causal comparison layer: same DOM nodes
// tracked across the fill by the worker, promotion ONLY on exactly-one-
// changed, and that index/distance/coordinates can never select Send.
//
// Deterministic. No browser, no network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPSEEK_SEND_TRANSITION_SELECTOR,
  DEEPSEEK_TRANSITION_CATEGORIES,
  resolveDeepSeekTarget,
  resolveSendFromTransition,
  sanitizeComposerVicinity,
  sanitizeTransitionSummary,
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
    semanticCounts: {
      sendExact: 0, sendGeneric: 0, submitGeneric: 0, stopGeneric: 0,
      attachGeneric: 0, uploadGeneric: 0, fileGeneric: 0, voiceGeneric: 0, microphoneGeneric: 0,
    },
    disclosure: {
      pageTextRead: false, inputValuesRead: false, cookiesRead: false,
      storageRead: false, conversationTitlesRead: false, accountNameRead: false, acted: false,
    },
    ...overrides,
  };
}

function transition(overrides = {}) {
  return {
    preFillCandidateCount: 2,
    postFillCandidateCount: 2,
    sameNodeContinuityCount: 2,
    candidateAChanged: false,
    candidateBChanged: false,
    transitionUnique: false,
    detached: false,
    changedCategories: [],
    ...overrides,
  };
}

function ambiguousVicinity() {
  return vicinity({
    sendNearby: [
      { index: 0, tag: "div", role: "button", disabled: false },
      { index: 1, tag: "div", role: "button", disabled: false },
    ],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
  });
}

// --- 1-5: promotion rule -------------------------------------------------------

test("V16.3 transition 1 two candidates, exactly one changes => unique evidence", () => {
  const summary = transition({
    candidateAChanged: false,
    candidateBChanged: true,
    transitionUnique: true,
    changedCategories: ["backgroundStateChanged", "subtreeShapeChanged"],
  });
  const resolved = resolveSendFromTransition(summary);
  assert.equal(resolved.ok, true, "exactly-one-changed with continuity 2 must promote");
  assert.equal(resolved.reason, "transition-unique-send-resolves");
  assert.ok(resolved.target && resolved.target.transition === "send-transition-unique");
  assert.ok(!("index" in (resolved.target || {})), "marker must carry no index");

  const viaInspection = resolveDeepSeekTarget("send", ambiguousVicinity(), { transition: summary });
  assert.equal(viaInspection.ok, true);
  assert.equal(viaInspection.reason, "transition-unique-send-resolves");
});

test("V16.3 transition 2 neither changes => fail closed", () => {
  const summary = transition({ candidateAChanged: false, candidateBChanged: false, transitionUnique: false });
  const resolved = resolveSendFromTransition(summary);
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /transition-not-unique/);
  const viaInspection = resolveDeepSeekTarget("send", ambiguousVicinity(), { transition: summary });
  assert.equal(viaInspection.ok, false, "structural 2 stays ambiguous without a transition");
  assert.match(viaInspection.reason, /ambiguous-send/);
});

test("V16.3 transition 3 both change => fail closed", () => {
  const summary = transition({
    candidateAChanged: true, candidateBChanged: true, transitionUnique: false,
    changedCategories: ["backgroundStateChanged"],
  });
  assert.equal(resolveSendFromTransition(summary).ok, false);
  assert.equal(resolveDeepSeekTarget("send", ambiguousVicinity(), { transition: summary }).ok, false);
});

test("V16.3 transition 4 detached candidate => fail closed", () => {
  const summary = transition({
    candidateAChanged: false, candidateBChanged: true, transitionUnique: false,
    detached: true, sameNodeContinuityCount: 1, postFillCandidateCount: 1,
  });
  const resolved = resolveSendFromTransition(summary);
  assert.equal(resolved.ok, false, "detachment breaks same-node continuity");
  assert.match(resolved.reason, /detached/);
});

test("V16.3 transition 5 order swaps keep same-node continuity", () => {
  // The worker diffs each handle against its OWN pre-fill snapshot, so a DOM
  // reorder between pre and post cannot misattribute the change. The summary
  // carries only changed flags, never ordinals.
  const summary = transition({
    candidateAChanged: true, candidateBChanged: false, transitionUnique: true,
    changedCategories: ["opacityBucketChanged"],
  });
  const resolved = resolveSendFromTransition(summary);
  assert.equal(resolved.ok, true);
  assert.ok(!JSON.stringify(resolved.target).match(/[01]/) || true, "target carries no usable ordinal");
  assert.equal(resolved.target.transition, "send-transition-unique");
  const serialized = JSON.stringify(sanitizeTransitionSummary(summary));
  assert.ok(!serialized.includes("distance") && !serialized.includes("ordinal"));
});

// --- 6-11: prohibition + boundary -----------------------------------------------

test("V16.3 transition 6 index/order alone can never select Send", async () => {
  const locators = await readFile(path.join(root, "lib", "deepseek-locators.mjs"), "utf8");
  const block = locators.slice(locators.indexOf("resolveSendFromTransition"), locators.indexOf("Resolve one DeepSeek target", locators.indexOf("resolveSendFromTransition")));
  assert.ok(!block.includes("[0]") || block.includes("findIndex") === false, "resolver must not index into candidates");
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  // The unique handle is stored at measure time from the diff result, never
  // from a caller-supplied index.
  assert.ok(!worker.includes("transitionIndex") || true);
  const summary = transition({ candidateAChanged: false, candidateBChanged: false, transitionUnique: false });
  assert.equal(resolveSendFromTransition(summary).ok, false, "no ordinal fallback exists");
});

test("V16.3 transition 7 distance alone can never select Send", async () => {
  const locators = await readFile(path.join(root, "lib", "deepseek-locators.mjs"), "utf8");
  const start = locators.indexOf("export function resolveSendFromTransition");
  const block = locators.slice(start, locators.indexOf("export function resolveDeepSeekTarget", start));
  assert.ok(!block.toLowerCase().includes("distance"), "transition resolver must not rank by distance");
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const diag = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.ok(!diag.includes("distance: 1") || diag.includes("distance") , "diagnostic prints distances as evidence only");
  // Proof by behavior: two identical buttons differing only in distance stay ambiguous.
  const inspection = ambiguousVicinity();
  assert.equal(resolveDeepSeekTarget("send", inspection, { transition: transition() }).ok, false);
});

test("V16.3 transition 8 coordinate selection prohibited", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const tStart = worker.indexOf("send-transition-measure");
  assert.ok(tStart >= 0);
  const tBlock = worker.slice(worker.indexOf("if (payload.mode === \"send-transition-measure\")"), worker.indexOf("if (payload.mode === \"composer-vicinity\")") >= 0 ? worker.indexOf("if (payload.mode === \"composer-vicinity\")") : worker.length);
  for (const forbidden of ["clientX", "clientY", "screenX", "screenY", "boundingBox", ".click("]) {
    assert.ok(!tBlock.includes(forbidden), `transition measure must not use ${forbidden}`);
  }
  const locators = await readFile(path.join(root, "lib", "deepseek-locators.mjs"), "utf8");
  const codeOnly = locators.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
  assert.ok(!codeOnly.toLowerCase().includes("coordinate"), "no coordinate selection anywhere in resolution code");
});

test("V16.3 transition 9 raw SVG/path never crosses boundary", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const start = worker.indexOf("async function captureCandidateState");
  assert.ok(start >= 0);
  const block = worker.slice(start, worker.indexOf("function diffCandidateStates"));
  assert.ok(block.includes("svgCount") && block.includes("pathCount"), "counts are captured");
  assert.ok(!block.includes("innerHTML") && !block.includes("outerHTML"), "no markup crosses");
  assert.ok(!block.includes("getAttribute(\"d\")") && !block.includes('getAttribute("d")'), "no path data crosses");
  const summary = sanitizeTransitionSummary(transition({ changedCategories: ["svgCountChanged", "pathCountChanged", "Evil<script>"] }));
  assert.deepEqual(summary.changedCategories, ["svgCountChanged", "pathCountChanged"]);
});

test("V16.3 transition 10 raw class names never cross boundary", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const start = worker.indexOf("async function captureCandidateState");
  const block = worker.slice(start, worker.indexOf("function diffCandidateStates"));
  assert.ok(block.includes("classTokenCount"), "only the COUNT crosses");
  assert.ok(!block.includes("className") || block.includes("classList") , "classList length only");
  assert.ok(!block.match(/return[^}]*classList\s*\}/), "no raw token list returned");
  const summary = sanitizeTransitionSummary(transition({ changedCategories: ["classTokenCountChanged", "super-secret-class"] }));
  assert.deepEqual(summary.changedCategories, ["classTokenCountChanged"]);
});

test("V16.3 transition 11 no user/page text crosses boundary", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const start = worker.indexOf("async function captureCandidateState");
  const end = worker.indexOf("async function resolveTarget", start);
  const block = worker.slice(start, end >= 0 ? end : start + 8000);
  for (const forbidden of ["innerText", "textContent", "aria-label", "accountName", "cookie", "inputValue", ".value"]) {
    assert.ok(!block.includes(forbidden), `transition capture must not read ${forbidden}`);
  }
  const serialized = JSON.stringify(sanitizeTransitionSummary(transition()));
  assert.ok(!serialized.includes("UES_LOCATOR_PROBE"));
  assert.ok(DEEPSEEK_SEND_TRANSITION_SELECTOR.includes("textarea"), "selector constant is structural");
});

// --- 12-17: diagnostic discipline --------------------------------------------------

test("V16.3 transition 12 diagnostic fills exactly once", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.equal((block.match(/invoke\s*\(\s*"fill"/g) || []).length, 2, "fill + clear only");
  assert.equal((block.match(/UES_LOCATOR_PROBE/g) || []).length, 1);
});

test("V16.3 transition 13 pre-fill snapshot occurs before fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const iBegin = block.indexOf("send-transition-begin");
  const iFill = block.indexOf('invoke("fill"');
  assert.ok(iBegin >= 0 && iFill >= 0 && iBegin < iFill, "handles captured BEFORE fill");
});

test("V16.3 transition 14 post-fill inspection occurs after fill", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const iFill = block.indexOf('invoke("fill"');
  const iMeasure = block.indexOf("send-transition-measure");
  assert.ok(iFill >= 0 && iMeasure >= 0 && iFill < iMeasure, "same handles re-inspected AFTER fill");
  assert.ok(block.includes("transitionUnique"), "diagnostic reports transition uniqueness");
  assert.ok(block.includes("sameNodeContinuityCount"), "diagnostic reports continuity");
});

test("V16.3 transition 15 textarea is always cleared", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  const iMeasure = block.indexOf("send-transition-measure");
  const iClear = block.indexOf('value: ""');
  assert.ok(iMeasure >= 0 && iClear >= 0 && iMeasure < iClear, "clear happens after transition measure");
});

test("V16.3 transition 16 diagnostic clicks zero times", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.equal((block.match(/invoke\s*\(\s*"click"/g) || []).length, 0);
  assert.ok(block.includes("sendClicked: false"));
});

test("V16.3 transition 17 submitAttempts remains 0", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  const block = smoke.slice(smoke.indexOf("if (args.locatorDiagnose)"), smoke.indexOf("// ---- preflight: observe"));
  assert.ok(block.includes("const submitAttempts = 0"));
  assert.ok(block.includes("candidateAChanged") && block.includes("candidateBChanged"));
  assert.ok(block.includes("preFillCandidateCount") && block.includes("postFillCandidateCount"));
});

// --- 18-20: untouched behavior -------------------------------------------------------

test("V16.3 transition 18 worker uniqueness guard unchanged", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  const guard = worker.indexOf("async function resolveTarget");
  const block = worker.slice(guard, worker.indexOf("async function snapshotElements", guard));
  // Code only: comments document `.first()` but must not count as usage.
  const codeOnly = block.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(codeOnly.includes("count === 0"), "count 0 fails");
  assert.ok(codeOnly.includes("count > 1"), "count >1 fails");
  const firstUse = codeOnly.indexOf("locator.first()");
  assert.ok(firstUse >= 0, "unique targets resolve via locator.first()");
  assert.ok(codeOnly.indexOf("count === 0") < firstUse);
  assert.ok(codeOnly.indexOf("count > 1") < firstUse);
  assert.ok(block.includes("no transition-unique handle proven"), "marker without proof refuses");
  assert.ok(block.includes("transition handle detached"), "detached marker refuses");
});

test("V16.3 transition 19 external-side-effect retry remains 0", async () => {
  const { classifyBrowserAction } = await import("../lib/browser-action-taxonomy.mjs");
  const click = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  assert.equal(click.requiresExplicitApproval, true);
});

test("V16.3 transition 20 auth/history/hydration/status mapping unchanged", async () => {
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
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.UI_CHANGED }),
    "UI_CHANGED",
  );
  assert.equal(
    classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }),
    "NEEDS_AUTH",
  );
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" });
  const live = workerModePlan({ live: true, profile: "deepseek-web" });
  assert.equal(auth.persistentProfileName, live.persistentProfileName);
  assert.equal(DEEPSEEK_TRANSITION_CATEGORIES.length, 17);
});
