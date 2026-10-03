// V16.3 real-live DeepSeek regressions.
//
// Two concrete bugs were found with real evidence from a headed, logged-in browser:
//
//   BUG A - the live/preflight branch started its worker with `live: false`
//            unconditionally, so `--live` ran EPHEMERAL and discarded the session
//            `--auth` had just persisted. Output read `profile: (ephemeral)`
//            while a real login existed on disk.
//   BUG B - `authProbeScript` computed `accountSignal` and the worker DROPPED it
//            from the auth payload, so `classifyAuthState` never received the
//            positive session signal and a genuinely logged-in page stayed
//            `composer-visible-but-no-session-signal` forever.
//
// Everything here is deterministic. No browser, no network, no DeepSeek.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  DEEPSEEK_PROFILE_NAME,
  authProbeScript,
  classifyAuthState,
  profileForMode,
} from "../lib/browser-profile.mjs"
import {
  WORKER_MODE,
  WORKER_PROFILE_MODE,
  expectedProfilePath,
  resolveWorkerMode,
  workerModePlan,
  workerModeViolation,
} from "../lib/browser-worker-mode.mjs"
import {
  BROWSER_WORKER_OPERATION,
  decodeWorkerResponse,
  encodeWorkerRequest,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs"
import { createBrowserWorkerClient } from "../lib/browser-worker-client.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONFIG = path.join("C:", "Users", "Tester", ".config", "ues");

// ---------------------------------------------------------------------------
// BUG A - worker mode matrix
// ---------------------------------------------------------------------------

test("V16.3 BUG A the default preflight is ephemeral, headless and mutates no profile", () => {
  const plan = workerModePlan({});
  assert.equal(plan.mode, WORKER_MODE.PREFLIGHT);
  assert.equal(plan.live, false);
  assert.equal(plan.headed, false);
  assert.equal(plan.expectedProfileMode, WORKER_PROFILE_MODE.EPHEMERAL);
  // No persistentProfileName means the preflight can neither read nor write the
  // persisted session.
  assert.equal(plan.persistentProfileName, null);
  assert.deepEqual(plan.scriptArgs, []);
  assert.equal(profileForMode({ live: plan.live, profile: plan.persistentProfileName || "" }).userDataDir, null);
});

test("V16.3 BUG A --auth is persistent and headed", () => {
  const plan = workerModePlan({ auth: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(plan.mode, WORKER_MODE.AUTH);
  assert.equal(plan.live, true);
  assert.equal(plan.headed, true);
  assert.equal(plan.expectedProfileMode, WORKER_PROFILE_MODE.PERSISTENT);
  assert.deepEqual(plan.scriptArgs, ["--live", `--profile=${DEEPSEEK_PROFILE_NAME}`, "--headed"]);
});

test("V16.3 BUG A --live is persistent and headless", () => {
  const plan = workerModePlan({ live: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(plan.mode, WORKER_MODE.LIVE);
  // This is the bug: --live used to resolve to ephemeral.
  assert.equal(plan.live, true, "--live must NEVER be ephemeral");
  assert.equal(plan.headed, false);
  assert.equal(plan.expectedProfileMode, WORKER_PROFILE_MODE.PERSISTENT);
  assert.deepEqual(plan.scriptArgs, ["--live", `--profile=${DEEPSEEK_PROFILE_NAME}`]);
});

test("V16.3 BUG A --auth and --live resolve to the IDENTICAL profile path", () => {
  const auth = expectedProfilePath(workerModePlan({ auth: true, profile: DEEPSEEK_PROFILE_NAME }), profileForMode);
  const live = expectedProfilePath(workerModePlan({ live: true, profile: DEEPSEEK_PROFILE_NAME }), profileForMode);
  assert.ok(auth, "--auth must resolve a profile path");
  assert.equal(auth, live, "--auth and --live must share one profile directory");
  assert.ok(auth.endsWith(path.join("browser-profiles", DEEPSEEK_PROFILE_NAME)));
  // And it is outside the repository.
  assert.ok(!auth.startsWith(root));
});

test("V16.3 BUG A the CI and release path is never persistent", async () => {
  // The mode resolver has no "CI" input at all, so CI can only ever reach
  // preflight: no script argument can opt it into a profile.
  assert.equal(resolveWorkerMode({}), WORKER_MODE.PREFLIGHT);
  assert.equal(workerModePlan({}).live, false);

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  for (const gate of ["ci", "release:verify", "test", "eval:v16", "eval:v16.3", "eval:v16.3.workers"]) {
    assert.ok(!String(scripts[gate] || "").includes("smoke:deepseek-web"), `${gate} must not run the live smoke`);
  }
  assert.ok(!String(scripts["smoke:deepseek-web"] || "").includes("--live"));
});

test("V16.3 BUG A a mode that promised persistent refuses to run ephemeral", () => {
  const live = workerModePlan({ live: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(workerModeViolation(live, { profileMode: "persistent" }), null);
  const violation = workerModeViolation(live, { profileMode: "ephemeral", profileReason: "not-a-live-mode" });
  assert.ok(violation, "--live on an ephemeral worker must be refused");
  assert.match(violation, /requires a persistent profile/);

  // A preflight is not violated by an ephemeral worker, but IS violated by one
  // that unexpectedly mutated the persisted profile.
  const pre = workerModePlan({});
  assert.equal(workerModeViolation(pre, { profileMode: "ephemeral" }), null);
  assert.ok(workerModeViolation(pre, { profileMode: "persistent" }));
});

test("V16.3 BUG A auth wins over live, and neither is inferred from a profile name", () => {
  assert.equal(resolveWorkerMode({ auth: true, live: true }), WORKER_MODE.AUTH);
  assert.equal(resolveWorkerMode({ live: false }), WORKER_MODE.PREFLIGHT);
  // A profile name alone must not switch persistence on.
  assert.equal(workerModePlan({ profile: DEEPSEEK_PROFILE_NAME }).mode, WORKER_MODE.PREFLIGHT);
  assert.equal(workerModePlan({ profile: DEEPSEEK_PROFILE_NAME }).live, false);
});

// ---------------------------------------------------------------------------
// BUG B - accountSignal propagation
// ---------------------------------------------------------------------------

test("V16.3 BUG B the probe script computes accountSignal and historyCount", () => {
  const script = authProbeScript({ answerSelectors: [".ds-markdown"], composerSelector: "#composer" });
  assert.ok(script.includes("accountSignal"), "the probe must compute accountSignal");
  assert.ok(script.includes("historyCount"), "the probe must compute a history count");
  // Generic and semantic only: no account name, no vendor identifier.
  for (const forbidden of ["accountName", "userName", "displayName", "email"]) {
    assert.ok(!script.includes(forbidden), `probe must not extract ${forbidden}`);
  }
});

test("V16.3 BUG B the worker payload carries accountSignal end to end", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  // The regression itself: the field existed in the probe and was dropped here.
  assert.ok(
    /auth:\s*\{[\s\S]*?accountSignal:\s*observations\.accountSignal === true/.test(worker),
    "the worker auth payload must forward accountSignal",
  );
  assert.ok(/historyCount:\s*Number\(observations\.historyCount \|\| 0\)/.test(worker));
});

test("V16.3 BUG B accountSignal survives protocol encode and decode", () => {
  const encoded = encodeWorkerResponse({
    ok: true,
    requestId: "p1",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: {
      auth: {
        url: "https://chat.deepseek.com/",
        title: "DeepSeek",
        text: "New chat",
        composerVisible: true,
        answerRegions: 0,
        accountSignal: true,
        historyCount: 4,
      },
    },
  });
  const decoded = decodeWorkerResponse(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.result.auth.accountSignal, true, "accountSignal must survive the boundary");
  assert.equal(decoded.result.auth.historyCount, 4);
});

test("V16.3 BUG B accountSignal=false is preserved rather than coerced to true", () => {
  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true,
    requestId: "p2",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: { auth: { url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 0, accountSignal: false, historyCount: 0 } },
  }));
  assert.equal(decoded.result.auth.accountSignal, false);
  assert.equal(decoded.result.auth.historyCount, 0);
});

test("V16.3 BUG B the auth-probe operation is a routable protocol operation", () => {
  const encoded = encodeWorkerRequest({
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    requestId: "p3",
    answerSelectors: [".ds-markdown"],
  });
  assert.equal(encoded.ok, true, "auth-probe must be routable, not refused as an unknown action");
  assert.equal(encoded.operation, BROWSER_WORKER_OPERATION.AUTH_PROBE);
});

test("V16.3 BUG B no account text, name or credential crosses the boundary", () => {
  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true,
    requestId: "p4",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: {
      auth: {
        url: "https://chat.deepseek.com/",
        composerVisible: true,
        answerRegions: 0,
        accountSignal: true,
        // A worker that wrongly emitted these must be scrubbed at the decoder.
        accountName: "Ada Lovelace",
        avatarAlt: "ada-avatar.png",
        cookie: "sid=abc123",
        localStorage: { token: "tok_abcdef" },
        inputValue: "hunter2",
      },
    },
  }));
  const serialized = JSON.stringify(decoded);
  for (const forbidden of ["Ada Lovelace", "ada-avatar", "sid=abc123", "tok_abcdef", "hunter2"]) {
    assert.ok(!serialized.includes(forbidden), `decoder must not carry ${forbidden}`);
  }
  for (const key of ["accountName", "avatarAlt", "localStorage", "inputValue"]) {
    assert.ok(!Object.hasOwn(decoded.result.auth, key), `decoder must not expose ${key}`);
  }
  assert.equal(decoded.result.auth.accountSignal, true);
});

// ---------------------------------------------------------------------------
// The auth decision itself
// ---------------------------------------------------------------------------

test("V16.3 BUG B composer + accountSignal is READY", () => {
  const state = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "New chat",
    composerVisible: true,
    answerRegions: 0,
    accountSignal: true,
    historyCount: 0,
  });
  assert.equal(state.state, AUTH_PROBE_STATE.READY);
  assert.equal(state.reason, "composer-and-account-signal-present");
});

test("V16.3 BUG B composer with no account signal and no answers is UNKNOWN", () => {
  const state = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "New chat Whenever you're ready",
    composerVisible: true,
    answerRegions: 0,
    accountSignal: false,
    historyCount: 0,
  });
  assert.equal(state.state, AUTH_PROBE_STATE.UNKNOWN);
  assert.equal(state.reason, "composer-visible-but-no-session-signal");
});

test("V16.3 the logged-out shell is UNKNOWN on every observed load", () => {
  // Observed live: the landing shell renders a prompt box and no session signal.
  for (const text of ["New chat\nWhenever you're ready\nDeepThink\nSearch", "chat good morning let s deepthink search"]) {
    const state = classifyAuthState({
      url: "https://chat.deepseek.com/",
      text,
      composerVisible: true,
      answerRegions: 0,
      accountSignal: false,
      historyCount: 0,
    });
    assert.equal(state.state, AUTH_PROBE_STATE.UNKNOWN, JSON.stringify(text));
  }
});

test("V16.3 each independent session signal admits READY", () => {
  const base = { url: "https://chat.deepseek.com/", composerVisible: true, text: "New chat" };
  assert.equal(classifyAuthState({ ...base, accountSignal: true, answerRegions: 0, historyCount: 0 }).state, AUTH_PROBE_STATE.READY);
  assert.equal(classifyAuthState({ ...base, accountSignal: false, answerRegions: 3, historyCount: 0 }).state, AUTH_PROBE_STATE.READY);
  assert.equal(classifyAuthState({ ...base, accountSignal: false, answerRegions: 0, historyCount: 5 }).state, AUTH_PROBE_STATE.READY);
  assert.equal(classifyAuthState({ ...base, accountSignal: false, answerRegions: 0, historyCount: 5 }).reason, "composer-and-history-present");
});

test("V16.3 a login wall still beats every positive signal", () => {
  const walled = classifyAuthState({
    url: "https://chat.deepseek.com/login",
    composerVisible: true,
    answerRegions: 4,
    accountSignal: true,
    historyCount: 9,
  });
  assert.equal(walled.state, AUTH_PROBE_STATE.NEEDS_AUTH);
});

// ---------------------------------------------------------------------------
// Live worker capability
// ---------------------------------------------------------------------------

test("V16.3 BUG A live worker capability reports the persistent profile", async () => {
  const listeners = [];
  const client = createBrowserWorkerClient({
    transport: {
      send(message) {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(encodeWorkerResponse({
              ok: true,
              requestId: message.requestId,
              operation: message.operation,
              payload: {
                playwright: "available",
                browserState: "ready",
                interactive: true,
                profileMode: "persistent",
                profileDir: path.join(CONFIG, "browser-profiles", DEEPSEEK_PROFILE_NAME),
                profileExists: true,
                headless: true,
              },
            }));
          }
        });
      },
      onMessage(listener) { listeners.push(listener); return () => {}; },
      close() {},
    },
  });
  const capability = await client.capability();
  assert.equal(capability.profileMode, "persistent");
  assert.equal(capability.profileExists, true);
  assert.equal(capability.headless, true);

  const live = workerModePlan({ live: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(workerModeViolation(live, capability), null, "a persistent capability satisfies --live");

  // An ephemeral capability would be refused, closing the loop on the bug.
  const ephemeral = workerModeViolation(live, { profileMode: "ephemeral" });
  assert.ok(ephemeral);
  await client.close();
});

test("V16.3 BUG A a consultation cannot proceed on an ephemeral profile in --live", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  // The refusal is an explicit capability guard, before any navigation or prompt.
  assert.ok(smoke.includes("workerModeViolation(workerPlan, capability)"));
  assert.ok(smoke.includes("HARD_NAVIGATION_FAILURE"));
  // And the preflight branch no longer hard-codes `live: false`.
  assert.ok(
    !/startWorker\(\{\s*live:\s*false/.test(smoke),
    "the hard-coded ephemeral live branch is the bug and must be gone",
  );
  assert.ok(smoke.includes("workerModePlan(args)"));
});

// ---------------------------------------------------------------------------
// Duplicate submit must not regress
// ---------------------------------------------------------------------------

test("V16.3 BUG B duplicate submit protection still holds through the live lane", async () => {
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
  let sends = 0;
  const answer = JSON.stringify({
    summary: "s", hypotheses: [], recommendedApproach: [], filesToInspect: [],
    risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.5,
  });
  const adapter = createDeepSeekWebAdapter({
    capability,
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      if (action === "click") sends += 1;
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      if (action === "snapshot") return { ok: true, result: { answer } };
      return { ok: true };
    },
  });
  const session = await adapter.startSession({});
  assert.equal(session.state, "ready");
  const first = await adapter.consult(session, { rendered: "p" }, { requestId: "dup-1" });
  assert.equal(first.ok, true);
  assert.equal(sends, 1);
  const replay = await adapter.consult(session, { rendered: "p" }, { requestId: "dup-1" });
  assert.equal(replay.ok, false);
  assert.equal(sends, 1, "a replayed prompt must never produce a second submit");
});

// ---------------------------------------------------------------------------
// CI isolation
// ---------------------------------------------------------------------------

test("V16.3 BUG A the release gate still forbids the live smoke", async () => {
  const check = await readFile(path.join(root, "scripts", "check-release-consistency.mjs"), "utf8");
  assert.ok(check.includes("ci must NOT run the live DeepSeek web smoke"));
  assert.ok(check.includes("release:verify must NOT run the live DeepSeek web smoke"));
});