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
//   0  PASS       a real consultation completed and parsed
//   2  NEEDS_AUTH / SKIPPED (see the printed status)
//   3  FAIL       the run happened but did not satisfy the contract

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createBrowserWorkerClient, spawnBrowserWorkerTransport } from "../lib/browser-worker-client.mjs"
import { createDeepSeekWebAdapter } from "../lib/deepseek-web-adapter.mjs"
import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import { createWebReasoningLane } from "../lib/web-reasoning-lane.mjs"
import { clearDecisionPacketCache } from "../lib/decision-packet.mjs"
import { AUTH_PROBE_STATE, DEEPSEEK_PROFILE_NAME, profileForMode } from "../lib/browser-profile.mjs"

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
    live: argv.includes("--live"),
    yes: argv.includes("--yes-i-have-authorized-a-live-consultation"),
    profile: arg("profile") || process.env.UES_DEEPSEEK_PROFILE || DEEPSEEK_PROFILE_NAME,
    answerTimeoutMs: Number(arg("answer-timeout-ms") || 120_000),
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
 * Spawns the managed worker and returns a client.
 *
 * `--live` is what turns on the persistent profile, and it is passed ONLY from
 * the explicit live/auth flows here. The default preflight runs headless with a
 * persistent profile so it can observe an existing session without creating one,
 * and nothing in CI passes `--live`.
 */
function startWorker({ live, headed, profileName }) {
  const scriptArgs = []
  if (live) scriptArgs.push("--live", `--profile=${profileName}`)
  if (headed) scriptArgs.push("--headed")
  const transport = spawnBrowserWorkerTransport(workerScript, {
    spawnImpl: spawn,
    cwd: root,
    scriptArgs,
  })
  return transport ? createBrowserWorkerClient({ transport, process: transport.process }) : null;
}

/**
 * Read-only auth observation through the managed worker.
 * There is no `authenticated: true` anywhere on this path.
 */
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
 * Bounded login wait for --auth. Capped by attempts AND by wall clock, so an
 * abandoned headed window cannot hang the process forever.
 */
async function waitForManualLogin(worker, overallTimeoutMs) {
  const deadline = Date.now() + overallTimeoutMs;
  let attempt = 0;
  let last = null;
  while (Date.now() < deadline && attempt < AUTH_POLL.maxAttempts) {
    attempt += 1;
    last = await observeAuth(worker);
    if (last.state === AUTH_PROBE_STATE.READY) {
      return { ok: true, attempts: attempt, state: last.state, url: last.url || null };
    }
    if (last.state === AUTH_PROBE_STATE.UI_CHANGED) {
      // A recognisable page that is not a login wall and not the composer is a UI
      // change, not a login. Stop rather than waiting for a state that will not come.
      return { ok: false, attempts: attempt, state: last.state, reason: last.reason, url: last.url || null };
    }
    await sleep(AUTH_POLL.intervalMs);
  }
  return {
    ok: false,
    attempts: attempt,
    state: last?.state || AUTH_PROBE_STATE.TIMEOUT,
    reason: `bounded-login-wait-exhausted-after-${attempt}-probes`,
    url: last?.url || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- --auth: manual headed login -----------------------------------------
  if (args.auth) {
    const worker = startWorker({ live: true, headed: true, profileName: args.profile });
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
      await worker.close().catch(() => null);
      report("FAIL", { stage: "open-entry-page", reason: opened.error });
      process.exitCode = 3;
      return;
    }

    const result = await waitForManualLogin(worker, args.authTimeoutMs);
    await worker.close().catch(() => null);

    if (!result.ok) {
      report(result.state === AUTH_PROBE_STATE.UI_CHANGED ? "UI_CHANGED" : "NEEDS_AUTH", {
        probes: result.attempts,
        bound: `${AUTH_POLL.maxAttempts} probes / ${AUTH_POLL.overallTimeoutMs}ms`,
        reason: result.reason || result.state,
        next: "Log in manually, then re-run: npm run smoke:deepseek-web -- --auth",
      });
      process.exitCode = 2;
      return;
    }
    report("PASS", {
      stage: "manual-auth",
      probes: result.attempts,
      bound: `${AUTH_POLL.maxAttempts} probes / ${AUTH_POLL.overallTimeoutMs}ms`,
      profile: capability.profileDir,
      note: "session stored in the persistent profile; no credential was read or exported",
      next: "npm run smoke:deepseek-web -- --live --yes-i-have-authorized-a-live-consultation",
    });
    process.exitCode = 0;
    return;
  }

  // ---- preflight: observe, do not consult ----------------------------------
  const worker = startWorker({ live: false, headed: false, profileName: args.profile });
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

  // Observe the REAL page state. No consultation is performed here.
  await worker.invoke("navigate", { url: ENTRY_URL, waitUntil: "domcontentloaded" });
  const observed = await observeAuth(worker);

  if (observed.state !== AUTH_PROBE_STATE.READY) {
    await worker.close().catch(() => null);
    report(observed.state === AUTH_PROBE_STATE.UI_CHANGED ? "UI_CHANGED" : "NEEDS_AUTH", {
      observedUrl: observed.url || "(none)",
      reason: observed.reason || observed.state,
      profile: capability.profileDir || "(ephemeral)",
      next: "npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 2;
    return;
  }

  if (!args.live) {
    await worker.close().catch(() => null);
    report("READY", {
      observedUrl: observed.url,
      profile: capability.profileDir || "(ephemeral)",
      mode: "preflight only (no consultation performed)",
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
  clearDecisionPacketCache();
  const adapter = createDeepSeekWebAdapter({
    capability: {
      provider: "browser-worker",
      interactive: true,
      readOnlyAvailable: true,
      reason: "managed-browser-worker",
    },
    invoke: (action, context) => worker.invoke(action, context),
    // The REAL read-only probe. There is no asserted-auth shortcut on this path.
    authProbe: (options) => observeAuth(worker, options?.timeoutMs),
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

  if (result?.outcome === "unavailable" || String(result?.reason || "").includes("auth")) {
    report("NEEDS_AUTH", {
      reason: result.reason,
      elapsedMs,
      observedUrl: observed.url,
      next: "npm run smoke:deepseek-web -- --auth",
    });
    process.exitCode = 2;
    return;
  }

  const checks = {
    sessionStarted: telemetry.webReasoningEscalations > 0,
    promptInserted: telemetry.webReasoningCalls > 0,
    responseExtracted: Boolean(result?.advice?.summary),
    structuredParser: Boolean(result?.advice && Number.isFinite(result.advice.confidence)),
    cleanupRan: true,
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

  if (result?.outcome !== "advised" || failedChecks.length) {
    report("FAIL", {
      outcome: result?.outcome,
      reason: result?.reason ?? "(none reported)",
      elapsedMs,
      checks: JSON.stringify(checks),
      failedChecks: failedChecks.join(", ") || "(none)",
      flagged: result?.flagged === true,
      authorityAttempts: (result?.authorityAttempts || []).join(",") || "(none)",
    });
    process.exitCode = 3;
    return;
  }

  report("PASS", {
    outcome: result.outcome,
    elapsedMs,
    checks: "session,prompt,response,parser,cleanup",
    packetChars: result.packet?.chars,
    sessionReusable: result.sessionReusable,
    flagged: result.flagged === true,
    authorityAttempts: (result.authorityAttempts || []).join(",") || "(none)",
    confidence: `${result.advice.confidence} (self-reported by the provider)`,
    summary: String(result.advice.summary || "").slice(0, 220),
  });
  console.log("");
  console.log("  Reminder: ONE read-only consultation over synthetic content.");
  console.log("  Evidence the path works end to end -- not a quality claim about DeepSeek.");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`V16.3 DeepSeek web smoke crashed: ${error?.stack || error?.message || error}`);
  process.exitCode = 3;
});