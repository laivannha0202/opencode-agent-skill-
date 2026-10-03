// V16.3 web-reasoning A/B benchmark harness contract.
//
// The live DeepSeek bridge is already verified end-to-end; these tests pin the
// BENCH harness wiring so a benchmark can never silently run ephemeral, fake
// auth, double-count telemetry, fabricate model performance, or submit without
// explicit consent.
//
// Deterministic. No browser, no network, no live provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { workerModePlan, workerModeViolation, WORKER_PROFILE_MODE } from "../lib/browser-worker-mode.mjs";
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs";
import { createSubmitGuard } from "../lib/browser-execution.mjs";
import {
  attachLiveWorker,
  buildLiveDeepSeekAdapter,
  createIsolatedWorkspace,
  evaluateLiveReadiness,
  parseArgs,
  planLiveBenchmarkBounds,
  runBenchmark,
} from "../scripts/bench-web-reasoning-ab.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function goodAdviceJson(file, confidence = 0.85) {
  return JSON.stringify({
    summary: "Deterministic bench fixture advice.",
    hypotheses: ["h"],
    recommendedApproach: ["Read the file."],
    filesToInspect: [file],
    risks: ["r"],
    edgeCases: [],
    verificationSuggestions: ["Run the targeted test."],
    confidence,
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
    counts: { "data-message-role-assistant": 0, "data-role-assistant": 0, "ds-markdown": 0, "assistant-class": 0 },
    selected: null,
    totalVisible: 0,
  };
}

function answerRegionsWith(key, count, text) {
  return {
    families: [
      { selectorKey: "data-message-role-assistant", visibleCount: key === "data-message-role-assistant" ? count : 0, latestTextChars: 0 },
      { selectorKey: "data-role-assistant", visibleCount: 0, latestTextChars: 0 },
      { selectorKey: "ds-markdown", visibleCount: key === "ds-markdown" ? count : 0, latestTextChars: String(text || "").length },
      { selectorKey: "assistant-class", visibleCount: 0, latestTextChars: 0 },
    ],
    counts: { "data-message-role-assistant": key === "data-message-role-assistant" ? count : 0, "data-role-assistant": 0, "ds-markdown": key === "ds-markdown" ? count : 0, "assistant-class": 0 },
    selected: count > 0 ? { selectorKey: key, visibleCount: count, textChars: String(text || "").length, answerText: String(text || "") } : null,
    totalVisible: count,
  };
}

// Minimal in-process worker-like client: real readiness + adapter hooks, fully
// scripted. No browser.
function makeFakeLiveWorker({ answerTexts = [], authState = "READY", calls = null } = {}) {
  const queue = [...answerTexts];
  const seen = calls || { invoke: [], domInspect: [], authProbe: 0, close: 0 };
  return {
    seen,
    isAlive: () => true,
    onClose: () => () => {},
    async invoke(action, context) {
      seen.invoke.push(action);
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: String(context?.value || "").length };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      return { ok: true };
    },
    async authProbe() {
      seen.authProbe += 1;
      if (authState === "READY") {
        return { state: "READY", reason: "composer-and-history-present", url: "https://chat.deepseek.com/", transportAlive: true, probeOnly: true };
      }
      return { state: authState, reason: "fake-not-ready", url: "https://chat.deepseek.com/", transportAlive: true, probeOnly: true };
    },
    async domInspect(options = {}) {
      const mode = String(options.mode || "");
      seen.domInspect.push(mode);
      if (mode === "composer-vicinity") return { ok: true, vicinity: composerVicinity() };
      if (mode === "send-transition-begin") {
        return { ok: true, transition: { preFillCandidateCount: 0, postFillCandidateCount: 0, sameNodeContinuityCount: 0, candidateAChanged: false, candidateBChanged: false, transitionUnique: false, detached: false, changedCategories: [] } };
      }
      if (mode === "send-transition-measure") {
        return { ok: true, transition: { preFillCandidateCount: 0, postFillCandidateCount: 0, sameNodeContinuityCount: 0, candidateAChanged: false, candidateBChanged: false, transitionUnique: false, detached: false, changedCategories: [] } };
      }
      if (mode === "deepseek-answer-regions") {
        const next = queue.length ? queue.shift() : answerRegionsEmpty();
        if (next && next.ok === false) return next;
        return { ok: true, answerRegions: next };
      }
      return { ok: true, vicinity: composerVicinity() };
    },
    async close() {
      seen.close += 1;
      return { closed: true };
    },
  };
}

const SMALL_TASKS = [
  { id: "t-hard", prompt: "The verifier still fails across modules; the root cause is ambiguous and several fixes are plausible.", difficulty: "hard", requiredFiles: ["lib/mcp-health.mjs"], expectedSignals: ["transient"] },
  { id: "t-easy", prompt: "Bump the package version in package.json to the next patch level.", difficulty: "easy", requiredFiles: ["package.json"], expectedSignals: ["version"] },
];

// --- 1-3: live worker mode ----------------------------------------------------

test("V16.3 bench 1 live benchmark uses workerModePlan scriptArgs", async () => {
  const captured = [];
  const spawnImpl = (...argv) => {
    captured.push(argv);
    return null;
  };
  const attached = await attachLiveWorker({ profile: "deepseek-web", spawnImpl });
  assert.equal(attached.ok, false, "null transport must fail closed");
  assert.ok(captured.length >= 1, "spawn must be attempted through the plan");
  const scriptArgs = captured[0][1].slice(1);
  assert.ok(scriptArgs.includes("--live"), `scriptArgs must carry --live, got ${scriptArgs}`);
  assert.ok(scriptArgs.some((entry) => entry.startsWith("--profile=")), `scriptArgs must carry --profile, got ${scriptArgs}`);
  assert.deepEqual(scriptArgs, workerModePlan({ live: true, profile: "deepseek-web" }).scriptArgs);
});

test("V16.3 bench 2 live requires a persistent profile", () => {
  const plan = workerModePlan({ live: true, profile: "deepseek-web" });
  assert.equal(plan.expectedProfileMode, WORKER_PROFILE_MODE.PERSISTENT);
  assert.equal(workerModeViolation(plan, { profileMode: "persistent" }), null);
});

test("V16.3 bench 3 ephemeral live worker fails closed", async () => {
  const plan = workerModePlan({ live: true, profile: "deepseek-web" });
  const violation = workerModeViolation(plan, { profileMode: "ephemeral", profileReason: "not-a-live-mode" });
  assert.ok(violation, "ephemeral capability must violate a live plan");
  assert.match(violation, /persistent/);

  // A spawn that cannot produce a worker must also fail closed (no consults).
  const spawnImpl = () => null;
  const attached = await attachLiveWorker({ profile: "deepseek-web", spawnImpl });
  assert.equal(attached.ok, false);
  assert.match(String(attached.reason || ""), /could not be started/);
});

// --- 4-6: real auth path, hooks -----------------------------------------------

test("V16.3 bench 4 real worker authProbe is used, never asserted true", async () => {
  const bench = await readFile(path.join(root, "scripts", "bench-web-reasoning-ab.mjs"), "utf8");
  assert.ok(bench.includes("authProbe: (options) => worker.authProbe("), "adapter must delegate to the worker probe");
  assert.ok(!bench.includes("authenticated: true"), "no asserted-auth shortcut may exist in live wiring");
  assert.ok(!bench.includes("authenticated:true"), "no asserted-auth shortcut may exist in live wiring");
  assert.ok(bench.includes("waitForAuthenticatedPage") || bench.includes("ensureLiveReady"), "bounded hydration settle must gate live runs");
});

test("V16.3 bench 5 liveInvoke without probe hooks fails closed with 0 submits", async () => {
  const result = await runBenchmark({
    live: true,
    liveBenchmarkConsent: true,
    liveInvoke: async () => ({ ok: true }),
    tasks: SMALL_TASKS,
    repeat: 1,
  });
  assert.equal(result.submitAttempts, 0);
  assert.equal(result.benchmarkReadiness.liveProviderMeasured, false);
  assert.match(result.benchmarkReadiness.status, /live-hooks-missing/);
  assert.equal(result.arms.a, null);
  assert.equal(result.arms.b, null);
});

test("V16.3 bench 6 domInspect transition and answer hooks are wired", async () => {
  const worker = makeFakeLiveWorker({ answerTexts: [answerRegionsEmpty(), answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, goodAdviceJson("lib/mcp-health.mjs"))] });
  const result = await runBenchmark({
    live: true,
    liveBenchmarkConsent: true,
    liveWorker: worker,
    tasks: [SMALL_TASKS[0]],
    repeat: 1,
  });
  assert.ok(worker.seen.domInspect.includes("composer-vicinity"), "composer/send vicinity must be inspected");
  assert.ok(worker.seen.domInspect.includes("deepseek-answer-regions"), "scoped answer regions must be polled");
  assert.ok(worker.seen.domInspect.includes("send-transition-begin"), "pre-fill transition must be captured");
  assert.ok(worker.seen.domInspect.includes("send-transition-measure"), "post-fill transition must be measured");
  assert.ok(worker.seen.authProbe >= 1, "real auth probe must run");
  assert.ok((result.submitAttempts || 0) >= 1, "a live hard task must submit");
  assert.equal(result.benchmarkReadiness.liveProviderMeasured, true);
});

// --- 7-9: telemetry ownership ---------------------------------------------------

test("V16.3 bench 7 shared web telemetry counts consultations", async () => {
  const worker = makeFakeLiveWorker({ answerTexts: [answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, goodAdviceJson("lib/mcp-health.mjs"))] });
  const result = await runBenchmark({ live: true, liveBenchmarkConsent: true, liveWorker: worker, tasks: [SMALL_TASKS[0]], repeat: 1 });
  assert.ok(Number(result.arms.b.webConsultations) >= 1, `expected measured consultations, got ${result.arms.b.webConsultations}`);
  assert.ok(Number(result.arms.b.decisionPacketChars) > 0, "packet chars must be measured");
});

test("V16.3 bench 8 browser telemetry counts real browser actions", async () => {
  const worker = makeFakeLiveWorker({ answerTexts: [answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, goodAdviceJson("lib/mcp-health.mjs"))] });
  const result = await runBenchmark({ live: true, liveBenchmarkConsent: true, liveWorker: worker, tasks: [SMALL_TASKS[0]], repeat: 1 });
  assert.ok(Number(result.arms.b.browserToolCalls) >= 3, `expected fill/click/answer reads, got ${result.arms.b.browserToolCalls}`);
});

test("V16.3 bench 9 follow-up accounting is single-sourced, never doubled", async () => {
  // Advice names a file outside knownFiles -> rejected -> bounded follow-up.
  const worker = makeFakeLiveWorker({
    answerTexts: [
      answerRegionsEmpty(),
      answerRegionsWith("ds-markdown", 1, goodAdviceJson("lib/not-in-repo.mjs")),
      answerRegionsWith("ds-markdown", 2, goodAdviceJson("lib/not-in-repo.mjs")),
      answerRegionsWith("ds-markdown", 2, goodAdviceJson("lib/not-in-repo.mjs")),
      answerRegionsWith("ds-markdown", 2, goodAdviceJson("lib/not-in-repo.mjs")),
    ],
  });
  const result = await runBenchmark({ live: true, liveBenchmarkConsent: true, liveWorker: worker, tasks: [SMALL_TASKS[0]], repeat: 1 });
  const rows = result.arms.b.perTask;
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok(typeof row.followUpChars === "number", "row must retain followUpChars");
    assert.ok(typeof row.verifierRetries === "number", "row must retain verifierRetries");
  }
  const rowSum = rows.reduce((sum, row) => sum + (Number(row.followUpChars) || 0), 0);
  assert.equal(result.arms.b.followUpDeltaChars, rowSum, "aggregate must equal the row sum exactly (no telemetry double-count)");
  assert.equal(result.arms.b.verifierRetries, rows.reduce((sum, row) => sum + (Number(row.verifierRetries) || 0), 0));
});

// --- 10-11: readiness ----------------------------------------------------------

test("V16.3 bench 10 liveProviderMeasured false before any real consultation", () => {
  assert.deepEqual(evaluateLiveReadiness({ live: false, liveCompletions: 0 }), {
    liveProviderAttached: false,
    liveProviderConsultations: 0,
    liveProviderMeasured: false,
    deterministicOnly: true,
  });
  const pending = evaluateLiveReadiness({ live: true, liveCompletions: 0 });
  assert.equal(pending.liveProviderAttached, true);
  assert.equal(pending.liveProviderMeasured, false);
});

test("V16.3 bench 11 liveProviderMeasured true only after actual completion", async () => {
  assert.equal(evaluateLiveReadiness({ live: true, liveCompletions: 2 }).liveProviderMeasured, true);
  const worker = makeFakeLiveWorker({ answerTexts: [answerRegionsEmpty(), answerRegionsWith("ds-markdown", 1, goodAdviceJson("lib/mcp-health.mjs"))] });
  const result = await runBenchmark({ live: true, liveBenchmarkConsent: true, liveWorker: worker, tasks: [SMALL_TASKS[0]], repeat: 1 });
  assert.equal(result.benchmarkReadiness.liveProviderMeasured, true);
  assert.ok(result.benchmarkReadiness.liveProviderConsultations >= 1);
  const offline = await runBenchmark({ tasks: [SMALL_TASKS[0]], repeat: 1 });
  assert.equal(offline.benchmarkReadiness.liveProviderMeasured, false);
  assert.equal(offline.benchmarkReadiness.deterministicOnly, true);
});

// --- 12: consent ----------------------------------------------------------------

test("V16.3 bench 12 live without explicit consent submits nothing", async () => {
  let spawned = false;
  const result = await runBenchmark({
    live: true,
    tasks: SMALL_TASKS,
    repeat: 1,
    spawnImpl: () => {
      spawned = true;
      return null;
    },
  });
  assert.equal(result.submitAttempts, 0);
  assert.equal(spawned, false, "no worker may spawn without consent");
  assert.match(result.benchmarkReadiness.status, /SKIPPED/);
  assert.equal(result.arms.a, null);
  assert.equal(result.arms.b, null);
  assert.ok(Number(result.liveBounds.maxSubmits) > 0, "bounded maximums must be printed before any run");
  const parsed = parseArgs(["--live"]);
  assert.equal(parsed.liveBenchmarkConsent, false);
  assert.equal(parseArgs(["--live", "--yes-i-have-authorized-a-live-benchmark"]).liveBenchmarkConsent, true);
});

// --- 13: easy-task non-escalation --------------------------------------------------

test("V16.3 bench 13 easy task AUTO never consults and never submits", async () => {
  const result = await runBenchmark({ tasks: SMALL_TASKS, repeat: 1 });
  const easy = result.arms.b.perTask.filter((row) => row.taskId === "t-easy");
  assert.ok(easy.length >= 1);
  for (const row of easy) {
    assert.equal(row.consultation.consulted, false);
    assert.equal(row.consultation.reason, "task-already-well-grounded");
    assert.equal(row.submitAttempts, 0);
  }
  assert.equal(result.arms.b.submitAttempts, 0, "deterministic run submits nothing");
});

// --- 14-16: honesty ---------------------------------------------------------------

test("V16.3 bench 14 deterministic fixture is clearly labelled non-model", async () => {
  const result = await runBenchmark({ tasks: [SMALL_TASKS[1]], repeat: 1 });
  assert.equal(result.arms.a.executorKind, "deterministic-fixture");
  assert.match(result.arms.a.executorNote || "", /not a model/i);
  assert.equal(result.arms.b.providerKind, "deterministic-provider-double");
  assert.equal(result.claimsVerified, false);
});

test("V16.3 bench 15 unavailable token metrics are null with reason", async () => {
  const result = await runBenchmark({ tasks: [SMALL_TASKS[1]], repeat: 1 });
  for (const arm of [result.arms.a, result.arms.b]) {
    assert.equal(arm.tokenMetrics.piInputTokens, null);
    assert.equal(arm.tokenMetrics.piOutputTokens, null);
    assert.equal(arm.tokenMetrics.measured, false);
    assert.ok(typeof arm.tokenMetrics.reason === "string" && arm.tokenMetrics.reason.length > 0);
  }
  // Packet estimate stays quarantined behind an estimated* name with basis.
  assert.ok(Number.isFinite(result.arms.b.tokenMetrics.estimatedTokensSent) || result.arms.b.tokenMetrics.estimatedTokensSent === null);
  assert.match(String(result.arms.b.tokenMetrics.estimatedTokenBasis || ""), /heuristic/);
});

test("V16.3 bench 16 no false savings claims", async () => {
  const result = await runBenchmark({ tasks: SMALL_TASKS, repeat: 1 });
  assert.equal(result.claimsVerified, false);
  assert.equal(result.comparison.claimsVerified, false);
  const serialized = JSON.stringify(result);
  assert.ok(!/improvement|faster-|% better|speedup/i.test(serialized), "no quality verdict may be asserted");
});

// --- 17-18: safety + isolation ------------------------------------------------------

test("V16.3 bench 17 submit retry remains zero and worktree untouched", async () => {
  const { classifyBrowserAction: classify } = await import("../lib/browser-action-taxonomy.mjs");
  const click = classify({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  const guard = createSubmitGuard();
  const taxonomy = { actionClass: "external-side-effect", action: "click" };
  assert.equal(guard.check({ sessionId: "s", taxonomy, locatorFingerprint: "f", beforeUrl: "u", idempotencyKey: "k", now: 1 }).allowed, true);
  assert.equal(guard.check({ sessionId: "s", taxonomy, locatorFingerprint: "f", beforeUrl: "u", idempotencyKey: "k", now: 2 }).allowed, false);
});

test("V16.3 bench 18 benchmark uses an isolated workspace and cleans up", async () => {
  const workspace = await createIsolatedWorkspace({ root, tasks: SMALL_TASKS });
  try {
    assert.ok(workspace.dir.startsWith(os.tmpdir()), `workspace must be temp, got ${workspace.dir}`);
    assert.ok(!workspace.dir.startsWith(root), "workspace must not be the working tree");
    assert.ok(workspace.copiedFiles >= 2);
    const { readFile: read } = await import("node:fs/promises");
    const copied = await read(path.join(workspace.dir, "package.json"), "utf8");
    assert.ok(copied.includes("opencode-agent-skill"));
  } finally {
    await workspace.cleanup();
  }
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(workspace.dir), false, "workspace must be removed afterwards");
  const traversal = await createIsolatedWorkspace({ root, tasks: [{ id: "x", requiredFiles: ["../../escape.mjs", "/abs.mjs"], expectedSignals: [] }] });
  try {
    assert.equal(traversal.copiedFiles, 0, "traversal/absolute paths must never be copied");
  } finally {
    await traversal.cleanup();
  }
});

test("V16.3 bench 19 live adapter carries production hooks", async () => {
  const worker = makeFakeLiveWorker({ answerTexts: [] });
  const { createBrowserTelemetry } = await import("../lib/browser-evidence.mjs");
  const adapter = buildLiveDeepSeekAdapter({
    worker,
    browserTelemetry: createBrowserTelemetry(),
    answerTimeoutMs: 5_000,
    now: Date.now,
    sleep: async () => {},
    counters: { fillAttempts: 0, submitAttempts: 0, snapshotAttempts: 0 },
  });
  assert.equal(adapter.id, "deepseek-web");
  assert.ok(adapter.options.answerTimeoutMs > 0);
  const bench = await readFile(path.join(root, "scripts", "bench-web-reasoning-ab.mjs"), "utf8");
  assert.ok(bench.includes("workerModePlan({ live: true"), "must reuse the smoke worker-mode policy");
  assert.ok(!bench.includes("authenticated: false"), "fake live-auth default must be gone");
});
