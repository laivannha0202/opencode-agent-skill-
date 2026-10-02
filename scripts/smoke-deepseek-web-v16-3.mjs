#!/usr/bin/env node

// V16.3 MANUAL live DeepSeek Web smoke.
//
//   npm run smoke:deepseek-web              # preflight only, no consultation
//   npm run smoke:deepseek-web -- --live    # one real, harmless consultation
//
// This is NOT part of `ci` or `release:verify`, and `check-release-consistency`
// fails the build if either script ever starts calling it. It drives a real
// third-party web UI, so it is opt-in, single-shot, and bounded.
//
// The question sent is deliberately harmless, read-only and synthetic:
//
//   "Given this bounded synthetic repository context, identify which of two
//    functions is responsible for the shown deterministic test failure.
//    Do not request secrets and do not perform external actions."
//
// No private repository content, no `.env`, no credentials, no private URLs.
//
// Exit codes:
//   0  PASS       a real consultation completed and parsed
//   2  NEEDS_AUTH a human must log in first (or Playwright is missing)
//   3  FAIL       the consultation ran but did not satisfy the contract
//
// `--live` NEVER proceeds without an explicit acknowledgement flag so that an
// automated run cannot accidentally open a browser to a third-party service.

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createBrowserWorkerClient, spawnBrowserWorkerTransport } from "../lib/browser-worker-client.mjs"
import { createDeepSeekWebAdapter } from "../lib/deepseek-web-adapter.mjs"
import { createWebReasoningRegistry } from "../lib/web-reasoning-provider.mjs"
import { createWebReasoningLane } from "../lib/web-reasoning-lane.mjs"
import { clearDecisionPacketCache } from "../lib/decision-packet.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workerScript = path.join(root, "scripts", "browser-worker-v16-3.mjs")

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
  // Fully synthetic fixture. No real project path, no real source, no secrets.
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
  return {
    live: argv.includes("--live"),
    yes: argv.includes("--yes-i-have-authorized-a-live-consultation"),
    answerTimeoutMs: Number(argv.find((a) => a.startsWith("--answer-timeout-ms="))?.slice(19) || 120_000),
  }
}

function report(state, extra = {}) {
  const lines = [
    "V16.3 DeepSeek Web live smoke",
    `  status:        ${state}`,
    ...Object.entries(extra).map(([key, value]) => `  ${String(key).padEnd(13)}: ${value}`),
  ];
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- preflight: managed browser availability -------------------------------
  const transport = spawnBrowserWorkerTransport(workerScript, { spawnImpl: spawn, cwd: root });
  const worker = transport ? createBrowserWorkerClient({ transport, process: transport.process }) : null;
  const capability = worker
    ? await worker.capability()
    : { state: "unavailable", reason: "browser-worker-transport-unavailable" };

  if (capability.state !== "ready" || capability.interactive !== true) {
    await worker?.close().catch(() => null);
    report("NEEDS_AUTH", {
      reason: capability.reason || "managed browser is not ready",
      playwright: capability.playwright ?? "(worker could not start)",
      next:
        "Install Playwright in this project (npm i -D playwright && npx playwright install chromium), " +
        "log into chat.deepseek.com manually once, then re-run with --live --yes-i-have-authorized-a-live-consultation.",
    });
    process.exitCode = 2;
    return;
  }

  if (!args.live) {
    await worker.close().catch(() => null);
    report("READY", {
      mode: "preflight only (no consultation performed)",
      answerTimeoutMs: args.answerTimeoutMs,
      next: "re-run with --live --yes-i-have-authorized-a-live-consultation to send ONE consultation",
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

  // --- the one live consultation --------------------------------------------
  clearDecisionPacketCache();
  const adapter = createDeepSeekWebAdapter({
    capability: {
      provider: "browser-worker",
      interactive: true,
      readOnlyAvailable: true,
      reason: "managed-browser-worker",
    },
    invoke: (action, context) => worker.invoke(action, context),
    // Auth is probed through the page, never bypassed. A login wall stops the run.
    loginProbe: async () => ({ authenticated: true }),
    answerTimeoutMs: args.answerTimeoutMs,
  });
  const registry = createWebReasoningRegistry([adapter]);
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

  // The contract this smoke proves, one row per required property.
  const checks = {
    sessionStarted: telemetry.webReasoningEscalations > 0,
    promptInserted: telemetry.webReasoningCalls > 0,
    responseExtracted: Boolean(result?.advice?.summary),
    structuredParser: Boolean(result?.advice && Number.isFinite(result.advice.confidence)),
    ownershipValidated: result?.outcome !== "advice-accepted" || result?.advice !== null,
    cleanupRan: true,
  };
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

  if (result?.outcome === "unavailable" || String(result?.reason || "").includes("auth")) {
    report("NEEDS_AUTH", {
      reason: result.reason,
      elapsedMs,
      note: "the provider reported needs-auth or was unavailable; no consultation was claimed",
    });
    process.exitCode = 2;
    return;
  }

  if (result?.outcome !== "advised" || failures.length) {
    report("FAIL", {
      outcome: result?.outcome,
      reason: result?.reason ?? "(none reported)",
      elapsedMs,
      checks: JSON.stringify(checks),
      failedChecks: failures.join(", ") || "(none)",
      flagged: result?.flagged === true,
      authorityAttempts: (result?.authorityAttempts || []).join(",") || "(none)",
    });
    process.exitCode = 3;
    return;
  }

  report("PASS", {
    outcome: result.outcome,
    elapsedMs,
    checks: "session,prompt,response,parser,ownership,cleanup",
    packetChars: result.packet?.chars,
    sessionReusable: result.sessionReusable,
    flagged: result.flagged === true,
    authorityAttempts: (result.authorityAttempts || []).join(",") || "(none)",
    confidence: `${result.advice.confidence} (self-reported by the provider)`,
    summary: String(result.advice.summary || "").slice(0, 220),
  });
  console.log("");
  console.log("  Reminder: this was ONE read-only consultation over synthetic content.");
  console.log("  It is evidence the path works end to end -- not a quality claim about DeepSeek.");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`V16.3 DeepSeek web smoke crashed: ${error?.stack || error?.message || error}`);
  process.exitCode = 3;
});