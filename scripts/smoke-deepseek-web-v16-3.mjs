#!/usr/bin/env node

// V16.3 MANUAL live DeepSeek Web smoke + manual auth.
//
//   npm run smoke:deepseek-web              # preflight only; no consultation
//   npm run smoke:deepseek-web -- --auth    # MANUAL headed login, saves a profile
//   npm run smoke:deepseek-web -- --live --yes-i-have-authorized-a-live-consultation
//
// This is NOT part of `ci` or `release:verify`, and `check-release-consistency`
// fails the build if either script ever starts calling it. It drives a real
// third-party web UI, so it is opt-in, single-shot and bounded.
//
// What it will NOT do:
//   - bypass login, solve a CAPTCHA, or inject credentials
//   - read, print, copy or export cookies, tokens, storage or session state
//   - poll indefinitely for a login that never happens
//
// What it sends (only in --live), over a SYNTHETIC context with no project
// source, no .env and no credentials:
//
//   "Given this bounded synthetic repository context, identify which of two
//    functions is responsible for the shown deterministic test failure.
//    Do not request secrets and do not perform external actions."
//
// Exit codes:
//   0  PASS       bridge integration verified: a real consultation completed,
//                parsed, reached the local verifier, and cleaned up. Advice may
//                be accepted OR rejected locally; see adviceAccepted.
//   2  NEEDS_AUTH / SKIPPED (see the printed status)
//   3  FAIL       the run happened but did not satisfy the contract

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createBrowserWorkerClient, spawnBrowserWorkerTransport } from "../lib/browser-worker-client.mjs"
import { createDeepSeekWebAdapter, classifyDeepSeekSmokeStatus, parseDeepSeekFailureStage, DEEPSEEK_FAILURE_STAGE } from "../lib/deepseek-web-adapter.mjs"
import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import { createWebReasoningLane } from "../lib/web-reasoning-lane.mjs"
import { clearDecisionPacketCache } from "../lib/decision-packet.mjs"
import {
  AUTH_PROBE_STATE,
  AUTH_SETTLE_LIMIT,
  AUTH_WAIT_LIMIT,
  AUTH_WAIT_STATE,
  DEEPSEEK_PROFILE_NAME,
  authWaitProgressLabel,
  nextAuthWaitState,
  waitForAuthenticatedPage,
} from "../lib/browser-profile.mjs"
import { WORKER_PROFILE_MODE, workerModePlan, workerModeViolation } from "../lib/browser-worker-mode.mjs";
import { evaluateDeepSeekSmokeResult, safeVerificationSummary } from "../lib/deepseek-smoke-result.mjs";
import { sanitizeDomInspection } from "../lib/browser-dom-inspect.mjs";
import { resolveDeepSeekTarget } from "../lib/deepseek-locators.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workerScript = path.join(root, "scripts", "browser-worker-v16-3.mjs")
const ENTRY_URL = "https://chat.deepseek.com/"

// Bounded login wait. A human is given a real chance, and the loop is capped in
// BOTH directions: no unbounded polling, no unbounded single wait.
const AUTH_POLL = Object.freeze({
  intervalMs: 2_000,
  maxAttempts: 90,          // ~3 minutes
  overallTimeoutMs: 180_000,
  probeTimeoutMs: 20_000,
})

const SYNTHETIC_CONTEXT = {
  originalTask:
    "Given this bounded synthetic repository context, identify which of two functions is responsible for the shown deterministic test failure. Do not request secrets and do not perform external actions.",
  requirements: [
    "Identify exactly one of alphaNormalize or betaJoin as responsible.",
    "Justify the choice using only the supplied synthetic code and the failure output.",
  ],
  constraints: [
    "MUST NOT request secrets, tokens, credentials or .env values.",
    "MUST NOT propose an external action, publish, push or deploy.",
    "MUST NOT claim the task is PASS.",
  ],
  verification: [
    "Read lib/synthetic/alpha.mjs and lib/synthetic/beta.mjs.",
    "Re-run the synthetic failing assertion locally.",
  ],
  relevantFiles: [
    {
      path: "lib/synthetic/alpha.mjs",
      reason: "candidate A: alphaNormalize trims and lowercases a token",
      code: "export function alphaNormalize(token) {\n  return String(token).trim().toLowerCase();\n}",
    },
    {
      path: "lib/synthetic/beta.mjs",
      reason: "candidate B: betaJoin concatenates segments",
      code: "export function betaJoin(segments) {\n  return segments.map((s) => String(s).trim()).join('');\n}",
    },
  ],
  evidence: [
    {
      kind: "test",
      source: "synthetic-failing-assertion",
      text: [
        "AssertionError: expected 'ab' but received 'a b'",
        "  at betaJoin (lib/synthetic/beta.mjs:2)",
        "  at testSyntheticJoin (synthetic.test.mjs:3)",
      ].join("\n"),
    },
  ],
  knownFiles: ["lib/synthetic/alpha.mjs", "lib/synthetic/beta.mjs"],
}

function parseArgs(argv) {
  const arg = (name) => (argv.find((entry) => entry.startsWith(`--${name}=`)) || "").split("=")[1] || "";
  return {
    auth: argv.includes("--auth"),
    authDiagnose: argv.includes("--auth-diagnose"),
    locatorDiagnose: argv.includes("--locator-diagnose"),
    answerDiagnose: argv.includes("--answer-diagnose"),
    live: argv.includes("--live"),
    yes: argv.includes("--yes-i-have-authorized-a-live-consultation"),
    profile: arg("profile") || process.env.UES_DEEPSEEK_PROFILE || DEEPSEEK_PROFILE_NAME,
    answerTimeoutMs: Number(arg("answer-timeout-ms") || 120_000),
    diagnoseLimit: Number(arg("diagnose-limit") || 60),
    authTimeoutMs: Number(arg("auth-timeout-ms") || AUTH_POLL.overallTimeoutMs),
  };
}

function report(state, extra = {}) {
  console.log(
    [
      "V16.3 DeepSeek Web live smoke",
      `  status:        ${state}`,
      ...Object.entries(extra).map(([key, value]) => `  ${String(key).padEnd(13)}: ${value}`),
    ].join("\n"),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawns the managed worker according to a resolved mode plan.
 *
 * The mode table and its rationale live in lib/browser-worker-mode.mjs. Only the
 * spawn lives here, so the decision cannot drift from the process arguments.
 */
function startWorker(plan) {
  const transport = spawnBrowserWorkerTransport(workerScript, {
    spawnImpl: spawn,
    cwd: root,
    scriptArgs: plan.scriptArgs,
  });
  return transport ? createBrowserWorkerClient({ transport, process: transport.process }) : null;
}

async function observeAuth(worker, timeoutMs = AUTH_POLL.probeTimeoutMs) {
  try {
    return await worker.authProbe({
      timeoutMs,
      answerSelectors: ["[data-message-role='assistant']", ".ds-markdown", "[class*='assistant']"],
    });
  } catch {
    return { state: AUTH_PROBE_STATE.TIMEOUT, reason: "auth-probe-threw", observations: null };
  }
}

/**
 * Bounded manual-login wait.
 *
 * The rule that matters: during MANUAL AUTH the page legitimately has no prompt
 * composer until a human has finished logging in. "Composer absent" is therefore
 * PENDING_AUTH, not a terminal UI_CHANGED -- treating it as terminal killed the
 * wait on probe 1, before the user could type anything.
 *
 * UI_CHANGED only becomes terminal AFTER a READY has been seen, which is the one
 * case with positive evidence of breakage: the page loaded, you were logged in,
 * and the expected UI stopped resolving.
 *
 * Exits are bounded by BOTH probe count and wall clock, and the poll always
 * sleeps between probes.
 */
async function waitForManualLogin(worker, overallTimeoutMs, options = {}) {
  const startedAt = Date.now();
  const maxAttempts = Number(options.maxAttempts) || AUTH_POLL.maxAttempts;
  const intervalMs = Number(options.intervalMs) || AUTH_POLL.intervalMs;
  const onLog = typeof options.onLog === "function" ? options.onLog : () => null;
  const sleepImpl = typeof options.sleep === "function" ? options.sleep : sleep;

  /** @type {any} */
  let closeEvent = null;
  const offClose = typeof worker?.onClose === "function"
    ? worker.onClose((event) => { closeEvent = event })
    : () => null;

  let attempt = 0;
  let seenReady = false;
  let last = null;

  try {
    while (true) {
      attempt += 1;
      const elapsedMs = Date.now() - startedAt;
      const transportAlive = !closeEvent && worker?.isAlive?.() !== false;

      const observation = transportAlive ? await observeAuth(worker) : null;

      // UNKNOWN is a REAL observation meaning "the page is up but I cannot see a
      // session". During manual login that is the normal state, so it must stay
      // PENDING. Only a genuinely dead lane -- no observation at all, or a
      // process that has exited -- is BROWSER_CLOSED. Conflating the two made the
      // wait report "browser closed" on probe 1 while the window was open.
      const observedState = observation?.state ? String(observation.state).toUpperCase() : null;
      const laneDead = !transportAlive || closeEvent !== null || worker?.isAlive?.() === false;

      const step = nextAuthWaitState({
        observation: laneDead ? null : observedState,
        transportAlive: !laneDead,
        navigationOk: true,
        seenReady,
        attempt,
        elapsedMs,
        maxAttempts,
        overallTimeoutMs,
        closeReason: closeEvent?.reason,
      });

      onLog(authWaitProgressLabel(step.state, attempt, maxAttempts));
      last = observation || null;

      if (step.state === AUTH_WAIT_STATE.READY) {
        seenReady = true;
        return { terminal: true, state: step.state, reason: step.reason, attempts: attempt, elapsedMs, url: observation.url || null };
      }
      if (step.terminal) {
        return {
          terminal: true,
          state: step.state,
          reason: step.reason,
          attempts: attempt,
          elapsedMs,
          url: observation.url || null,
          closeReason: closeEvent?.reason || null,
        };
      }

      // Always sleep: the wait must never spin on a page that is still loading.
      await sleepImpl(Math.max(AUTH_WAIT_LIMIT.minIntervalMs, Math.min(AUTH_WAIT_LIMIT.maxIntervalMs, intervalMs)));
    }
  } finally {
    offClose();
  }
}


/** Booleans and counts only. Safe to print for a manual diagnosis. */
function client_authDebugSummary(worker, probe) {
  const observations = probe?.observations || {};
  return {
    composerVisible: observations.composerVisible === true,
    accountSignal: observations.accountSignal === true,
    historyCount: Number(observations.historyCount || 0),
    answerRegions: Number(observations.answerRegions || 0),
    urlPath: String(observations.url || "").split("?")[0].split("#")[0].slice(0, 120),
    classifiedState: String(probe?.state || "UNKNOWN"),
    reason: String(probe?.reason || "").slice(0, 120),
    disclosure: "booleans and counts only; no page content, no account text, no credentials",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- --auth: manual headed login -----------------------------------------
  if (args.auth) {
    const authPlan = workerModePlan(args);
    const worker = startWorker(authPlan);
    if (!worker) {
      report("NEEDS_AUTH", { reason: "managed browser worker could not be started" });
      process.exitCode = 2;
      return;
    }
    const capability = await worker.capability();
    if (capability.state !== "ready" || capability.interactive !== true) {
      await worker.close().catch(() => null);
      report("NEEDS_AUTH", {
        reason: capability.reason || "managed browser is not ready",
        playwright: capability.playwright ?? "(worker could not start)",
      });
      process.exitCode = 2;
      return;
    }

    const authViolation = workerModeViolation(authPlan, capability);
    if (authViolation) {
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", { stage: "persistent-profile", reason: authViolation });
      process.exitCode = 3;
      return;
    }

    console.log("V16.3 DeepSeek Web — MANUAL AUTH MODE");
    console.log(`  profile:   ${capability.profileDir || "(ephemeral)"}`);
    console.log(`  mode:      ${capability.profileMode} (headless=${capability.headless})`);
    console.log(`  opening:   ${ENTRY_URL}`);
    console.log("");
    console.log("  A headed browser window is open. Log in to DeepSeek yourself.");
    console.log("  This tool does NOT read, store, print or export your credentials,");
    console.log("  and it does not bypass login or any CAPTCHA.");
    console.log("");

    const opened = await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
    if (!opened.ok) {
      // A real entry-navigation failure is a hard failure, distinct from "you did
      // not log in": the operator must fix the environment, not retry the login.
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", {
        stage: "open-entry-page",
        reason: opened.error || "entry navigation did not complete",
      });
      process.exitCode = 3;
      return;
    }

    const result = await waitForManualLogin(worker, args.authTimeoutMs, {
      onLog: (line) => console.log(`  ${line}`),
    });
    // Close the persistent context cleanly. The profile on disk survives, so the
    // NEXT `--live` invocation reuses the session this run established.
    await worker.close().catch(() => null);

    if (result.state === AUTH_WAIT_STATE.READY) {
      report("AUTH_READY", {
        probes: `${result.attempts}/${AUTH_POLL.maxAttempts}`,
        elapsed: `${result.elapsedMs}ms`,
        bound: `${AUTH_POLL.maxAttempts} probes / ${AUTH_POLL.overallTimeoutMs}ms`,
        reason: result.reason,
        profile: capability.profileDir,
        note: "session stored in the persistent profile; no credential was read or exported",
        next: "npm run smoke:deepseek-web -- --live --yes-i-have-authorized-a-live-consultation",
      });
      process.exitCode = 0;
      return;
    }

    if (result.state === AUTH_WAIT_STATE.BROWSER_CLOSED) {
      report("BROWSER_CLOSED", {
        probes: `${result.attempts}/${AUTH_POLL.maxAttempts}`,
        elapsed: `${result.elapsedMs}ms`,
        reason: result.closeReason || result.reason,
        next: "re-run: npm run smoke:deepseek-web -- --auth and leave the window open while you log in",
      });
      process.exitCode = 2;
      return;
    }

    if (result.state === AUTH_WAIT_STATE.UI_CHANGED) {
      // Terminal only after a READY: the session was authenticated and the
      // expected UI then stopped resolving. That is drift, not "not logged in".
      report("UI_CHANGED", {
        probes: `${result.attempts}/${AUTH_POLL.maxAttempts}`,
        elapsed: `${result.elapsedMs}ms`,
        reason: result.reason,
        next: "the authenticated page loaded but the expected chat UI could not be resolved; the provider selectors may need updating",
      });
      process.exitCode = 2;
      return;
    }

    report("NEEDS_AUTH", {
      probes: `${result.attempts}/${AUTH_POLL.maxAttempts}`,
      elapsed: `${result.elapsedMs}ms`,
      bound: `${AUTH_POLL.maxAttempts} probes / ${AUTH_POLL.overallTimeoutMs}ms`,
      reason: result.reason || "bounded-login-wait-exhausted",
      next: "log in within the headed window, then re-run: npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 2;
    return;
  }

  // ---- --auth-diagnose: READ-ONLY DOM evidence for selector repair ---------
  //
  // Why it exists: the user was visibly logged in and the detector still reported
  // no session for 89 probes. Guessing new selectors would be guessing, so this
  // mode prints the MEASURED structure of the real page instead.
  //
  // Safety: the in-page script withholds page text, input values, cookies,
  // storage, conversation titles and account names; the client re-filters with
  // sanitizeDomInspection(); and only structure, booleans and counts are printed.
  // It never clicks, types or submits.
  if (args.authDiagnose) {
    const plan = workerModePlan({ live: true, profile: args.profile });
    const worker = startWorker(plan);
    if (!worker) {
      report("NEEDS_AUTH", { reason: "managed browser worker could not be started" });
      process.exitCode = 2;
      return;
    }
    const capability = await worker.capability();
    const violation = workerModeViolation(plan, capability);
    if (violation) {
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", { stage: "persistent-profile", reason: violation });
      process.exitCode = 3;
      return;
    }

    const opened = await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
    console.log("");
    console.log("V16.3 DeepSeek Web — READ-ONLY AUTH DIAGNOSTIC");
    console.log(`  profile:  ${capability.profileDir || "(ephemeral)"}`);
    console.log(`  mode:     ${capability.profileMode} (headless=${capability.headless})`);
    console.log(`  navigate: ${opened.ok ? `ok -> ${opened.afterUrl}` : `FAILED -> ${opened.error}`}`);
    console.log("");
    console.log("  Nothing is clicked, typed or submitted. No cookies, storage, tokens,");
    console.log("  input values, conversation titles or account names are read or printed.");
    console.log("");

    // Bounded settle so the SPA has hydrated before measuring.
    await sleep(4_000);

    const probe = await observeAuth(worker);
    console.log("AUTH SUMMARY (booleans and counts only)");
    console.log(JSON.stringify(client_authDebugSummary(worker, probe), null, 2));
    console.log("");

    const inspected = await worker.domInspect({ limit: Number(args.diagnoseLimit) || 60, timeoutMs: 30_000 });
    await worker.close().catch(() => null);

    if (!inspected.ok) {
      report("HARD_NAVIGATION_FAILURE", { stage: "dom-inspect", reason: inspected.reason || inspected.failure });
      process.exitCode = 3;
      return;
    }

    const inspection = sanitizeDomInspection(inspected.inspection);
    console.log("AGGREGATE COUNTS");
    console.log(JSON.stringify(inspection.aggregates, null, 2));
    console.log("");
    console.log("VISIBLE ELEMENT STRUCTURE (bounded)");
    for (const row of inspection.rows) {
      const bits = [String(row.tag).padEnd(10)];
      if (row.role) bits.push(`role=${row.role}`);
      if (row.ariaLabel?.present) bits.push(`aria=${row.ariaLabel.generic ?? "[withheld]"}`);
      if (row.testId) bits.push("data-testid=[present]");
      if (row.hasNameAttr) bits.push("name=[present]");
      if (row.type) bits.push(`type=${row.type}`);
      if (row.contentEditable) bits.push(`contenteditable=${row.contentEditable}`);
      if (row.ariaHaspopup) bits.push(`aria-haspopup=${row.ariaHaspopup}`);
      if (row.href) bits.push(`href=${row.href.shape}${row.href.hasQuery ? "?<redacted>" : ""}`);
      if (row.classTokens.length) bits.push(`class=${row.classTokens.join(".")}`);
      if (row.classFiltered) bits.push(`(+${row.classFiltered} filtered)`);
      if (row.inSidebar) bits.push("[in-sidebar]");
      bits.push(`children=${row.childCount}`);
      console.log("  " + bits.join(" "));
    }
    console.log("");
    console.log("DISCLOSURE");
    console.log(JSON.stringify(inspection.disclosure));
    console.log("");
    console.log("Selector repair note: use the aggregates and the sidebar rows above.");
    console.log("If accountCandidates is 0 but you are logged in, the account affordance is");
    console.log("not matched - re-run and share the aggregate counts only.");
    process.exitCode = 0;
    return;
  }

  // ---- --locator-diagnose: READ-ONLY PRE-SUBMIT composer/send/answer resolution
  //
  // Pre-submit validation without a consultation. Reproduces the REAL
  // production PRE-SUBMIT sequence exactly, minus the submit:
  //   auth READY -> inspect/resolve composer -> PRE-FILL candidate snapshot
  //   (same-node handles) -> fill synthetic non-secret text -> POST-FILL
  //   inspect SAME handles -> accessibility counts -> transition comparison ->
  //   resolve send from POST-FILL evidence -> CLEAR composer -> verify cleared
  //   -> close. NEVER clicks Send. No prompt is submitted, no answer is read.
  // The reported send state always reflects POST-FILL evidence, never stale
  // pre-fill evidence: a toolbar/control-state change caused by the non-empty
  // composer is observed before any readiness claim.
  if (args.locatorDiagnose) {
    const plan = workerModePlan({ live: true, profile: args.profile });
    const worker = startWorker(plan);
    if (!worker) {
      report("NEEDS_AUTH", { reason: "managed browser worker could not be started" });
      process.exitCode = 2;
      return;
    }
    const capability = await worker.capability();
    const violation = workerModeViolation(plan, capability);
    if (violation) {
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", { stage: "persistent-profile", reason: violation });
      process.exitCode = 3;
      return;
    }

    const opened = await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
    console.log("");
    console.log("V16.3 DeepSeek Web — READ-ONLY LOCATOR DIAGNOSTIC (PRE-SUBMIT, POST-FILL)");
    console.log(`  profile:  ${capability.profileDir || "(ephemeral)"}`);
    console.log(`  mode:     ${capability.profileMode} (headless=${capability.headless})`);
    console.log(`  navigate: ${opened.ok ? `ok -> ${opened.afterUrl}` : `FAILED -> ${opened.error}`}`);
    console.log("");
    console.log("  Nothing is submitted and Send is never clicked. The composer fill");
    console.log("  test uses synthetic non-secret content and clears it afterwards.");
    console.log("");

    const settled = await waitForAuthenticatedPage(worker);
    if (settled.state !== AUTH_PROBE_STATE.READY) {
      await worker.close().catch(() => null);
      report("NEEDS_AUTH", {
        reason: settled.reason || settled.state,
        authProbes: settled.authProbes ?? 1,
        authSettleMs: settled.authSettleMs ?? 0,
        next: "npm run smoke:deepseek-web -- --auth",
      });
      process.exitCode = 2;
      return;
    }

    // Bounded side-effect-free counters. submitAttempts (clicks) must stay 0:
    // this diagnostic never submits. Proven by the absence of any click
    // invocation below, not by elapsed time.
    let fillAttempts = 0;
    const submitAttempts = 0;
    let domInspects = 0;

    // Step 1: pre-fill inspect + resolve composer (read-only, before any fill).
    const preVic = await worker.domInspect({ mode: "composer-vicinity", nearbyLimit: 10, timeoutMs: 30_000 });
    domInspects += 1;
    if (!preVic.ok) {
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", { stage: "locator-inspect", reason: preVic.reason || preVic.failure });
      process.exitCode = 3;
      return;
    }

    const composer = resolveDeepSeekTarget("composer", preVic.vicinity);
    const preSendStale = resolveDeepSeekTarget("send", preVic.vicinity);
    const preAnswer = resolveDeepSeekTarget("answer", preVic.vicinity);

    // Step 1b: PRE-FILL same-node candidate snapshot (read-only, before fill).
    // Captures ElementHandles for the Send structural candidates; handles stay
    // worker-side. Continuity is by attachment, never index/distance/coords.
    let transitionBegin = null;
    if (composer.ok) {
      try {
        const begun = await worker.domInspect({ mode: "send-transition-begin", timeoutMs: 30_000 });
        domInspects += 1;
        if (begun && begun.ok === true && begun.transition) transitionBegin = begun.transition;
      } catch { transitionBegin = null; }
    }

    // Step 2: fill ONCE with synthetic non-secret content. No submit.
    let fillTest = composer.ok ? "not-attempted" : "skipped-no-composer";
    let filledChars = 0;
    let failureStage = null;
    if (!composer.ok) {
      failureStage = DEEPSEEK_FAILURE_STAGE.COMPOSER_RESOLVE;
    } else {
      const filled = await worker.invoke("fill", {
        target: composer.target,
        value: "UES_LOCATOR_PROBE",
        actionTimeoutMs: 15_000,
      });
      fillAttempts = 1;
      filledChars = Number(filled.filledChars ?? filled.result?.filledChars ?? 0);
      fillTest = filled.ok && filledChars > 0 ? `ok:${filledChars}` : `failed:${String(filled.error || "unverified").slice(0, 80)}`;
      if (!(filled.ok && filledChars > 0)) {
        failureStage = DEEPSEEK_FAILURE_STAGE.COMPOSER_FILL;
      }
    }

    // Step 3: POST-FILL re-inspection (mandatory, after fill, before send).
    // This is the coverage the old diagnostic lacked: DeepSeek may change the
    // toolbar/control state after the textarea becomes non-empty, so the send
    // decision must use fresh POST-FILL evidence, never the stale pre-fill one.
    // SAME handles are re-inspected first (causal comparison immune to order
    // swaps), then the vicinity + accessibility semantics.
    let postVicinity = null;
    let postFillSend = { ok: false, strategy: null, target: null, candidates: 0, reason: "not-inspected" };
    let postFillAnswer = { ok: true, strategy: null, target: null, candidates: 0, reason: "not-inspected" };
    let transitionSummary = null;
    if (composer.ok && fillTest.startsWith("ok:")) {
      try {
        const measured = await worker.domInspect({ mode: "send-transition-measure", timeoutMs: 30_000 });
        domInspects += 1;
        if (measured && measured.ok === true && measured.transition) transitionSummary = measured.transition;
      } catch { transitionSummary = null; }
      const postVic = await worker.domInspect({ mode: "composer-vicinity", nearbyLimit: 10, timeoutMs: 30_000 });
      domInspects += 1;
      if (!postVic.ok) {
        failureStage = failureStage || DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL;
        postFillSend = { ok: false, strategy: null, target: null, candidates: 0, reason: String(postVic.reason || postVic.failure || "post-fill-inspect-failed").slice(0, 160) };
      } else {
        postVicinity = postVic.vicinity;
        postFillSend = resolveDeepSeekTarget("send", postVic.vicinity, { transition: transitionSummary });
        postFillAnswer = resolveDeepSeekTarget("answer", postVic.vicinity);
        if (!postFillSend.ok && !failureStage) {
          failureStage = DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL;
        }
      }
    }

    // Step 4: CLEAR composer even if send resolution failed (finally-style).
    // The composer must never be left holding synthetic text.
    let clearTest = composer.ok && fillTest.startsWith("ok:") ? "not-attempted" : "skipped";
    let inputCleared = false;
    if (composer.ok && fillTest.startsWith("ok:")) {
      try {
        const cleared = await worker.invoke("fill", {
          target: composer.target,
          value: "",
          actionTimeoutMs: 15_000,
        });
        const clearedChars = Number(cleared.filledChars ?? cleared.result?.filledChars ?? -1);
        inputCleared = cleared.ok && clearedChars === 0;
        clearTest = inputCleared ? "ok:cleared" : `failed:${String(cleared.error || clearedChars).slice(0, 80)}`;
      } catch (error) {
        clearTest = `failed:${String(error?.message || error).slice(0, 80)}`;
      }
    }
    const clearOk = clearTest === "ok:cleared";
    await worker.close().catch(() => null);

    // Safe POST-FILL send DOM measurements (bounded, generic, no content):
    // visible generic buttons near composer with enabled/disabled, role,
    // generic aria-label, generic control-name token, safe dimensions,
    // composer-relative relationship, per-selector visible-match counts, and
    // Playwright accessibility-semantic counts (numbers only, measured
    // POST-FILL via the browser's own accessible-name engine). No text,
    // SVG/path data, ids, hrefs, values, or account data. No arbitrary
    // accessible name is ever printed.
    const safeNearby = (postVicinity?.sendNearby || []).slice(0, 10).map((row) => ({
      tag: String(row?.tag || "").slice(0, 20),
      role: row?.role ? String(row.role).slice(0, 30) : null,
      disabled: row?.disabled === true,
      aria: row?.ariaLabel?.generic || null,
      control: row?.controlName?.generic || null,
      testId: row?.testId === "[present]" ? "[present]" : null,
      box: row?.box && typeof row.box === "object" ? { w: Math.max(0, Number(row.box.w) || 0), h: Math.max(0, Number(row.box.h) || 0) } : null,
      afterComposer: row?.afterComposer === true ? true : row?.afterComposer === false ? false : null,
      distance: row?.distance === null || row?.distance === undefined ? null : Math.max(0, Number(row.distance) || 0),
      ariaHasPopup: row?.ariaHasPopup === true,
      ariaExpanded: row?.ariaExpanded === true,
      ariaControlsPresent: row?.ariaControlsPresent === true,
      containsFileInput: row?.containsFileInput === true,
      insideLabel: row?.insideLabel === true,
      dataStatePresent: row?.dataStatePresent === true,
      childCount: Math.max(0, Number(row?.childCount) || 0),
      tabIndex: row?.tabIndex === null || row?.tabIndex === undefined ? null : row.tabIndex,
    }));
    const sendMatches = postVicinity?.sendMatches || {};
    // The visible-match count that drove the decision: 1 when unique, the
    // ambiguous selector's count (2) when fail-closed. Nearby length is
    // reported separately as sendCandidates; it must not inflate this number.
    const postFillSendMatches = postFillSend.ok
      ? 1
      : Math.max(0, ...Object.values(sendMatches).map((n) => Number(n) || 0));
    // Accessibility-semantic counts (POST-FILL, numbers only). Computed by the
    // worker with page.getByRole().count() AFTER the synthetic fill, so they
    // reflect post-fill semantics. Never names, trees, or text.
    const semantic = postVicinity?.semanticCounts && typeof postVicinity.semanticCounts === "object"
      ? postVicinity.semanticCounts
      : {};
    const semanticSendExactCount = Math.max(0, Number(semantic.sendExact) || 0);
    const semanticSendGenericCount = Math.max(0, Number(semantic.sendGeneric) || 0);
    const semanticSubmitCount = Math.max(0, Number(semantic.submitGeneric) || 0);
    const semanticStopCount = Math.max(0, Number(semantic.stopGeneric) || 0);
    const semanticAttachCount = Math.max(0, Number(semantic.attachGeneric) || 0);
    const semanticUploadCount = Math.max(0, Number(semantic.uploadGeneric) || 0);
    const semanticFileCount = Math.max(0, Number(semantic.fileGeneric) || 0);
    const semanticVoiceCount = Math.max(0, Number(semantic.voiceGeneric) || 0);
    const semanticMicrophoneCount = Math.max(0, Number(semantic.microphoneGeneric) || 0);

    console.log("");
    console.log("POST-FILL SEND DOM (safe: counts, roles, generic tokens, dimensions only)");
    console.log(JSON.stringify({ sendTotal: postVicinity?.sendTotal ?? null, sendMatches, sendNearby: safeNearby }, null, 2));
    console.log("");
    console.log("POST-FILL ACCESSIBILITY SEMANTICS (safe: numeric counts only, no names)");
    console.log(JSON.stringify({
      semanticSendExactCount,
      semanticSendGenericCount,
      semanticSubmitCount,
      semanticStopCount,
      semanticAttachCount,
      semanticUploadCount,
      semanticFileCount,
      semanticVoiceCount,
      semanticMicrophoneCount,
    }, null, 2));
    console.log("");
    // Same-node transition summary (diagnostic labels A/B only; never used as
    // a production locator — only the same-node marker may target).
    const transitionSafe = transitionSummary && typeof transitionSummary === "object" ? transitionSummary : null;
    const preFillCandidateCount = Math.max(0, Number(transitionSafe?.preFillCandidateCount ?? transitionBegin?.preFillCandidateCount) || 0);
    const postFillCandidateCount = Math.max(0, Number(transitionSafe?.postFillCandidateCount) || 0);
    const sameNodeContinuityCount = Math.max(0, Number(transitionSafe?.sameNodeContinuityCount) || 0);
    const candidateAChanged = transitionSafe?.candidateAChanged === true;
    const candidateBChanged = transitionSafe?.candidateBChanged === true;
    const transitionUnique = transitionSafe?.transitionUnique === true;
    const transitionDetached = transitionSafe?.detached === true;
    const transitionChangedCategories = Array.isArray(transitionSafe?.changedCategories)
      ? transitionSafe.changedCategories.filter((entry) => typeof entry === "string").slice(0, 17)
      : [];
    console.log("PRE/POST-FILL TRANSITION (safe: counts and changed flags only, no positions used as locators)");
    console.log(JSON.stringify({
      preFillCandidateCount,
      postFillCandidateCount,
      sameNodeContinuityCount,
      candidateTransitionSummary: { candidateAChanged, candidateBChanged },
      transitionUnique,
      transitionDetached,
      transitionChangedCategories,
    }, null, 2));
    console.log("");

    const ready = composer.ok && fillTest.startsWith("ok:") && postFillSend.ok && clearOk;
    if (!failureStage && !ready) {
      failureStage = !composer.ok
        ? DEEPSEEK_FAILURE_STAGE.COMPOSER_RESOLVE
        : !fillTest.startsWith("ok:")
          ? DEEPSEEK_FAILURE_STAGE.COMPOSER_FILL
          : !postFillSend.ok
            ? DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL
            : DEEPSEEK_FAILURE_STAGE.DISPATCH_VERIFY;
    }
    report(ready ? "LOCATOR_READY" : "UI_CHANGED", {
      failureStage: failureStage || (ready ? "(none)" : DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL),
      composerStrategy: composer.strategy || "(none)",
      composerSelector: composer.target?.selector || composer.target?.accessibleName || "(none)",
      composerCandidates: composer.candidates ?? 0,
      composerReason: composer.reason || "",
      fillTest,
      filledChars,
      preFillCandidateCount,
      postFillCandidateCount,
      sameNodeContinuityCount,
      candidateAChanged,
      candidateBChanged,
      transitionUnique,
      transitionChangedCategories,
      postFillSendStrategy: postFillSend.strategy || "(none)",
      postFillSendMatches,
      postFillSendReason: postFillSend.reason || "",
      semanticSendExactCount,
      semanticSendGenericCount,
      semanticSubmitCount,
      semanticStopCount,
      semanticAttachCount,
      semanticUploadCount,
      semanticFileCount,
      semanticVoiceCount,
      semanticMicrophoneCount,
      // Aliases for the pre-postfill field names so existing readiness checks
      // keep working: they now always reflect POST-FILL evidence.
      sendStrategy: postFillSend.strategy || "(none)",
      sendCandidates: postFillSend.candidates ?? 0,
      sendReason: postFillSend.reason || "",
      preFillSendReason: preSendStale.reason || "",
      answerStrategy: (postFillAnswer.strategy || preAnswer.strategy) || "(none)",
      answerCandidates: (postFillAnswer.candidates ?? preAnswer.candidates) ?? 0,
      answerReason: (postFillAnswer.reason || preAnswer.reason) || "",
      clearTest,
      inputCleared,
      sendClicked: false,
      fillAttempts,
      submitAttempts,
      snapshotAttempts: 0,
      domInspects,
    });
    process.exitCode = ready ? 0 : 3;
    return;
  }

  // ---- --answer-diagnose: READ-ONLY answer-region inspection -----------------
  //
  // Never sends a prompt. Inspects an already-open/existing conversation
  // READ-ONLY via the dedicated `deepseek-answer-regions` path (bounded
  // assistant regions only; never whole-page body text, sidebar/history text,
  // or account text). Reports only counts/strategy/chars; answer text is NOT
  // printed by default. No fill, no click Send, submitAttempts=0 always. If no
  // existing answer region is active, reports NO_EXISTING_ANSWER_TO_DIAGNOSE
  // honestly instead of navigating into a private conversation to fake a PASS.
  if (args.answerDiagnose) {
    const plan = workerModePlan({ live: true, profile: args.profile });
    const worker = startWorker(plan);
    if (!worker) {
      report("NEEDS_AUTH", { reason: "managed browser worker could not be started" });
      process.exitCode = 2;
      return;
    }
    const capability = await worker.capability();
    const violation = workerModeViolation(plan, capability);
    if (violation) {
      await worker.close().catch(() => null);
      report("HARD_NAVIGATION_FAILURE", { stage: "persistent-profile", reason: violation });
      process.exitCode = 3;
      return;
    }

    const opened = await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
    console.log("");
    console.log("V16.3 DeepSeek Web — READ-ONLY ANSWER DIAGNOSTIC");
    console.log(`  profile:  ${capability.profileDir || "(ephemeral)"}`);
    console.log(`  mode:     ${capability.profileMode} (headless=${capability.headless})`);
    console.log(`  navigate: ${opened.ok ? `ok -> ${opened.afterUrl}` : `FAILED -> ${opened.error}`}`);
    console.log("");
    console.log("  Nothing is filled, clicked, typed or submitted. No answer text is printed.");
    console.log("  Only scoped assistant-region counts/strategy/chars are reported.");
    console.log("");

    // Bounded settle so the SPA has hydrated before measuring. READ-ONLY.
    await sleep(4_000);

    const settled = await waitForAuthenticatedPage(worker);
    if (settled.state !== AUTH_PROBE_STATE.READY) {
      await worker.close().catch(() => null);
      report("NEEDS_AUTH", {
        reason: settled.reason || settled.state,
        authProbes: settled.authProbes ?? 1,
        authSettleMs: settled.authSettleMs ?? 0,
        fillAttempts: 0,
        submitAttempts: 0,
        snapshotAttempts: 0,
        next: "npm run smoke:deepseek-web -- --auth",
      });
      process.exitCode = 2;
      return;
    }

    // Side-effect-free counters. submitAttempts must stay 0: this diagnostic
    // never fills and never clicks. Proven by the absence of any fill/click
    // invocation below.
    const fillAttempts = 0;
    const submitAttempts = 0;
    let domInspects = 0;

    const inspected = await worker.domInspect({ mode: "deepseek-answer-regions", timeoutMs: 30_000 });
    domInspects += 1;
    await worker.close().catch(() => null);

    if (!inspected.ok) {
      report("ANSWER_DIAGNOSE", {
        reason: inspected.reason || inspected.failure || "answer-inspect-failed",
        fillAttempts,
        submitAttempts,
        snapshotAttempts: 0,
        domInspects,
      });
      process.exitCode = 3;
      return;
    }

    const regions = inspected.answerRegions || {};
    const families = Array.isArray(regions.families) ? regions.families : [];
    const answerSelectorCounts = {};
    for (const row of families) {
      if (row && row.selectorKey) answerSelectorCounts[row.selectorKey] = Math.max(0, Number(row.visibleCount) || 0);
    }
    const totalVisible = Math.max(0, Number(regions.totalVisible) || Object.values(answerSelectorCounts).reduce((s, n) => s + (Number(n) || 0), 0));
    const selected = regions.selected || null;

    if (totalVisible === 0 || !selected) {
      report("NO_EXISTING_ANSWER_TO_DIAGNOSE", {
        reason: "no assistant answer region is active in the current conversation",
        answerSelectorCounts: JSON.stringify(answerSelectorCounts),
        selectedAnswerStrategy: "(none)",
        selectedAnswerCount: 0,
        answerTextChars: 0,
        fillAttempts,
        submitAttempts,
        snapshotAttempts: 0,
        domInspects,
        note: "open a conversation with an assistant answer, then re-run; no navigation into private conversations was performed",
      });
      process.exitCode = 2;
      return;
    }

    report("ANSWER_DIAGNOSED", {
      answerSelectorCounts: JSON.stringify(answerSelectorCounts),
      selectedAnswerStrategy: selected.selectorKey || "(none)",
      selectedAnswerCount: Math.max(0, Number(selected.visibleCount) || 0),
      answerTextChars: Math.max(0, Number(selected.textChars) || 0),
      fillAttempts,
      submitAttempts,
      snapshotAttempts: 0,
      domInspects,
      disclosure: "counts/strategy/chars only; answer text withheld by default",
    });
    process.exitCode = 0;
    return;
  }

  // ---- preflight: observe, do not consult ----------------------------------
  const workerPlan = workerModePlan(args);
  const worker = startWorker(workerPlan);
  if (!worker) {
    report("NEEDS_AUTH", { reason: "managed browser worker could not be started" });
    process.exitCode = 2;
    return;
  }
  const capability = await worker.capability();
  if (capability.state !== "ready" || capability.interactive !== true) {
    await worker.close().catch(() => null);
    report("NEEDS_AUTH", {
      reason: capability.reason || "managed browser is not ready",
      playwright: capability.playwright ?? "(worker could not start)",
      next: "npm i -D playwright && npx playwright install chromium",
    });
    process.exitCode = 2;
    return;
  }

  // A live consultation MUST be on the persisted profile. If the worker came back
  // ephemeral, the session established by --auth is not reachable and proceeding
  // would report a spurious auth failure, so refuse instead.
  const liveViolation = args.live === true ? workerModeViolation(workerPlan, capability) : null;
  if (liveViolation) {
    await worker.close().catch(() => null);
    report("HARD_NAVIGATION_FAILURE", {
      stage: "persistent-profile",
      reason: liveViolation,
      expected: WORKER_PROFILE_MODE.PERSISTENT,
    });
    process.exitCode = 3;
    return;
  }

  // Observe the REAL page state with a SHORT bounded SPA hydration settle.
  // DeepSeek hydrates sidebar/history asynchronously (~2s): a single immediate
  // probe races hydration and reports UNKNOWN on an authenticated profile.
  // The settle probes immediately, returns on READY, fails fast on a login
  // wall, and retries UNKNOWN/UI_CHANGED/TIMEOUT for ~6s max. READ-ONLY: one
  // navigation above, no navigation retry, no click/type/submit here.
  await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
  const settled = await waitForAuthenticatedPage(worker);
  const observed = settled.probe || settled;

  if (settled.state !== AUTH_PROBE_STATE.READY) {
    await worker.close().catch(() => null);
    report(settled.state === AUTH_PROBE_STATE.UI_CHANGED ? "UI_CHANGED" : settled.state === "CLOSED" ? "NEEDS_AUTH" : observed.state === AUTH_PROBE_STATE.UI_CHANGED ? "UI_CHANGED" : "NEEDS_AUTH", {
      observedUrl: settled.url || observed.url || "(none)",
      mode: `${workerPlan.mode} (${capability.profileMode})`,
      reason: settled.reason || observed.reason || settled.state,
      profile: capability.profileDir || "(ephemeral)",
      authProbes: settled.authProbes ?? settled.attempts ?? 1,
      authSettleMs: settled.authSettleMs ?? settled.elapsedMs ?? 0,
      authBound: `${AUTH_SETTLE_LIMIT.maxAttempts} probes / ${AUTH_SETTLE_LIMIT.overallTimeoutMs}ms`,
      next: "npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 2;
    return;
  }

  if (!args.live) {
    await worker.close().catch(() => null);
    report("READY", {
      observedUrl: settled.url || observed.url,
      mode: `${workerPlan.mode} (${capability.profileMode}) - no consultation performed`,
      profile: capability.profileDir || "(ephemeral)",
      authProbes: settled.authProbes ?? 1,
      authSettleMs: settled.authSettleMs ?? 0,
      next: "npm run smoke:deepseek-web -- --live --yes-i-have-authorized-a-live-consultation",
    });
    process.exitCode = 0;
    return;
  }

  if (!args.yes) {
    await worker.close().catch(() => null);
    report("SKIPPED", {
      reason: "--live requires --yes-i-have-authorized-a-live-consultation",
      next: "this guard exists so an automated run can never open a third-party browser unannounced",
    });
    process.exitCode = 2;
    return;
  }

  // ---- --live: ONE real consultation ----------------------------------------
  // Bounded action counters at the smoke layer. Proven from the actual invoke
  // calls below, never inferred from elapsed time. Proves fill-once /
  // submit-at-most-once for the current run. Answer-region reads
  // (READ-ONLY domInspect) also count as snapshotAttempts so the answer-wait
  // evidence stays comparable to the pre-fix runs.
  let liveFillAttempts = 0;
  let liveClickAttempts = 0;
  let liveSnapshotAttempts = 0;
  const countingInvoke = async (action, context) => {
    if (action === "fill") liveFillAttempts += 1;
    if (action === "click") liveClickAttempts += 1;
    if (action === "snapshot") liveSnapshotAttempts += 1;
    return worker.invoke(action, context);
  };
  const countingDomInspect = async (options) => {
    const mode = String(options?.mode || "composer-vicinity");
    if (mode === "deepseek-answer-regions") liveSnapshotAttempts += 1;
    return worker.domInspect({ mode: "composer-vicinity", ...(options || {}), mode });
  };
  clearDecisionPacketCache();
  const adapter = createDeepSeekWebAdapter({
    capability: {
      provider: "browser-worker",
      interactive: true,
      readOnlyAvailable: true,
      reason: "managed-browser-worker",
    },
    invoke: countingInvoke,
    // The REAL read-only probe. There is no asserted-auth shortcut on this path.
    authProbe: (options) => observeAuth(worker, options?.timeoutMs),
    // Measured locator evidence for the composer/send/answer cascade.
    // Routes the requested mode through (composer-vicinity for locators,
    // deepseek-answer-regions for scoped answer reads) and counts answer
    // reads as snapshotAttempts for comparable answer-wait evidence.
    domInspect: countingDomInspect,
    // Same-node pre/post-fill transition evidence (read-only, handles stay
    // worker-side). Lets the live lane promote a unique transition the same
    // way the diagnostic does; ambiguity still fails closed before any click.
    transitionBegin: async () => worker.domInspect({ mode: "send-transition-begin", timeoutMs: 30_000 }),
    transitionMeasure: async () => worker.domInspect({ mode: "send-transition-measure", timeoutMs: 30_000 }),
    answerTimeoutMs: args.answerTimeoutMs,
  });
  const lane = createWebReasoningLane({
    mode: "force",
    live: true,
    adapters: [adapter],
    buildPacket: () => SYNTHETIC_CONTEXT,
  });

  const startedAt = Date.now();
  let result = null;
  try {
    result = await lane.consult({
      task: SYNTHETIC_CONTEXT.originalTask,
      requestId: `smoke-${Date.now().toString(36)}`,
    });
  } catch (error) {
    result = { outcome: "FAIL", reason: `consult-threw:${error?.message || error}` };
  } finally {
    await lane.close().catch(() => null);
    await worker.close().catch(() => null);
  }

  const elapsedMs = Date.now() - startedAt;
  const telemetry = result?.telemetry || {};
  const liveCounters = { fillAttempts: liveFillAttempts, submitAttempts: liveClickAttempts, snapshotAttempts: liveSnapshotAttempts };

  // Stage-specific safe evidence: the failure stage survives in the reason
  // suffix (e.g. `...:send-resolve-post-fill:...`). Only bounded stage names,
  // strategies, counts and counters are printed -- never prompt contents,
  // input values, conversation content, account data, cookies/storage, or URLs
  // with query/ids.
  const failureStage = parseDeepSeekFailureStage(String(result?.reason || "")) || "(none)";

  // Corrected status classification: a generic "unavailable" outcome is NEVER
  // authentication. Only an explicit `deepseek-auth-required` reason is
  // NEEDS_AUTH. Selector drift is UI_CHANGED, timeouts are TIMEOUT/FAIL, and
  // browser problems are UNAVAILABLE. FORCE-mode semantics are preserved: every
  // non-PASS status here fails loudly (no silent fallback).
  const smokeStatus = classifyDeepSeekSmokeStatus(result);
  if (smokeStatus === "NEEDS_AUTH") {
    report("NEEDS_AUTH", {
      reason: result.reason,
      failureStage,
      elapsedMs,
      observedUrl: observed.url,
      authProbes: settled.authProbes ?? 1,
      authSettleMs: settled.authSettleMs ?? 0,
      fillAttempts: liveCounters.fillAttempts,
      submitAttempts: liveCounters.submitAttempts,
      snapshotAttempts: liveCounters.snapshotAttempts,
      next: "npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 2;
    return;
  }
  if (smokeStatus === "UI_CHANGED" || smokeStatus === "UNAVAILABLE" || smokeStatus === "TIMEOUT") {
    report(smokeStatus, {
      reason: result.reason,
      failureStage,
      elapsedMs,
      observedUrl: observed.url,
      authProbes: settled.authProbes ?? 1,
      authSettleMs: settled.authSettleMs ?? 0,
      fillAttempts: liveCounters.fillAttempts,
      submitAttempts: liveCounters.submitAttempts,
      snapshotAttempts: liveCounters.snapshotAttempts,
      outcome: result?.outcome ?? "(none)",
      next: smokeStatus === "UI_CHANGED"
        ? "npm run smoke:deepseek-web -- --locator-diagnose"
        : "npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 3;
    return;
  }

  // Browser-evidence checks (NOT telemetry inference). promptFilled and
  // promptSubmitted come from bounded action counters; webReasoningCalls is
  // telemetry only and must never prove a browser insertion. The old
  // inserted-flag derived from webReasoningCalls printed false on a real run
  // with fillAttempts=1/submitAttempts=1 and is therefore removed.
  //
  // Smoke contract (integration vs acceptance are SEPARATE):
  //   A. INTEGRATION SUCCESS = session started, prompt filled once, prompt
  //      submitted once, response extracted, structured parser succeeded,
  //      local verifier ran, cleanup ran.
  //   B. ADVICE ACCEPTANCE = verification.accepted true/false.
  // A local verification REJECTION is a valid safe system outcome, not an
  // integration failure. PASS requires A plus a completed consultation
  // (outcome advised OR advice-rejected). Rejected advice never produces
  // advisorText and never authorizes action (runtime invariant, unchanged).
  const evaluated = evaluateDeepSeekSmokeResult({
    result,
    telemetry,
    counters: liveCounters,
    cleanupRan: true,
  });
  const checks = evaluated.checks;
  const failedChecks = evaluated.failedChecks;
  // SAFE bounded verification metadata only: counts plus structural
  // rejection fields (status/rejection/safe path). Never DeepSeek prose.
  const verificationSummary = safeVerificationSummary(result?.verification, SYNTHETIC_CONTEXT.knownFiles);

  if (evaluated.status !== "PASS") {
    report("FAIL", {
      outcome: result?.outcome,
      reason: result?.reason ?? "(none reported)",
      failureStage,
      elapsedMs,
      fillAttempts: liveCounters.fillAttempts,
      submitAttempts: liveCounters.submitAttempts,
      snapshotAttempts: liveCounters.snapshotAttempts,
      checks: JSON.stringify(checks),
      failedChecks: failedChecks.join(", ") || "(none)",
      integrationVerified: evaluated.integrationVerified,
      adviceAccepted: evaluated.adviceAccepted,
      consultationCompleted: evaluated.consultationCompleted,
      responseParsed: evaluated.responseParsed,
      localVerifierRan: evaluated.localVerifierRan,
      verificationAccepted: verificationSummary.verificationAccepted,
      verificationRejectionCount: verificationSummary.verificationRejectionCount,
      verificationConfirmations: verificationSummary.verificationConfirmations,
      verificationRejections: JSON.stringify(verificationSummary.verificationRejections),
      flagged: result?.flagged === true,
      authorityAttempts: (result?.authorityAttempts || []).join(",") || "(none)",
    });
    process.exitCode = 3;
    return;
  }

  report("PASS", {
    outcome: result.outcome,
    integrationVerified: evaluated.integrationVerified,
    adviceAccepted: evaluated.adviceAccepted,
    consultationCompleted: evaluated.consultationCompleted,
    responseParsed: evaluated.responseParsed,
    elapsedMs,
    authProbes: settled.authProbes ?? 1,
    authSettleMs: settled.authSettleMs ?? 0,
    fillAttempts: liveCounters.fillAttempts,
    submitAttempts: liveCounters.submitAttempts,
    snapshotAttempts: liveCounters.snapshotAttempts,
    checks: JSON.stringify(checks),
    failedChecks: failedChecks.join(", ") || "(none)",
    localVerifierRan: evaluated.localVerifierRan,
    verificationAccepted: verificationSummary.verificationAccepted,
    verificationRejectionCount: verificationSummary.verificationRejectionCount,
    verificationConfirmations: verificationSummary.verificationConfirmations,
    verificationRejections: JSON.stringify(verificationSummary.verificationRejections),
    packetChars: result.packet?.chars,
    sessionReusable: result.sessionReusable,
    flagged: result.flagged === true,
    authorityAttempts: (result.authorityAttempts || []).join(",") || "(none)",
    confidence: result?.advice ? `${result.advice.confidence} (self-reported by the provider)` : "(none)",
    summary: result?.advice ? String(result.advice.summary || "").slice(0, 220) : "(rejected advice carries no trusted summary)",
  });
  console.log("");
  console.log("  Reminder: ONE consultation over synthetic content; PASS proves the");
  console.log("  bridge operated end to end. Rejected advice is a safe local verdict,");
  console.log("  not a recommendation, and never enters executor context.");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`V16.3 DeepSeek web smoke crashed: ${error?.stack || error?.message || error}`);
  process.exitCode = 3;
});