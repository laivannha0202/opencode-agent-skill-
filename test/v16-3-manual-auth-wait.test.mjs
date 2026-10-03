// V16.3 manual-auth wait: the bug that made `--auth` useless.
//
// Real observed bug: `npm run smoke:deepseek-web -- --auth` opened the headed
// browser and exited on probe 1 with `UI_CHANGED`, because a missing prompt
// composer was treated as terminal. During MANUAL AUTH the composer is legitimately
// absent until a HUMAN has logged in, so the wait has to survive that.
//
// These tests drive the state machine and the wait loop directly, with a fake
// worker. No browser, no network, no DeepSeek.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  AUTH_WAIT_LIMIT,
  AUTH_WAIT_STATE,
  authWaitProgressLabel,
  nextAuthWaitState,
  terminalAuthWaitState,
} from "../lib/browser-profile.mjs"
import { createBrowserWorkerClient } from "../lib/browser-worker-client.mjs"
import { BROWSER_WORKER_OPERATION, encodeWorkerResponse } from "../lib/browser-worker-protocol.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const BASE = {
  transportAlive: true,
  navigationOk: true,
  seenReady: false,
  maxAttempts: AUTH_WAIT_LIMIT.maxAttempts,
  overallTimeoutMs: AUTH_WAIT_LIMIT.overallTimeoutMs,
};

// ---------------------------------------------------------------------------
// The pure state machine
// ---------------------------------------------------------------------------

test("V16.3 auth-wait a first UI_CHANGED is PENDING, never terminal", () => {
  const step = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.UI_CHANGED, attempt: 1, elapsedMs: 2_000 });
  assert.equal(step.state, AUTH_WAIT_STATE.PENDING);
  assert.equal(step.terminal, false);
  assert.equal(step.reason, "waiting-for-login");
  assert.equal(terminalAuthWaitState(step.state), false);
});

test("V16.3 auth-wait a UNKNOWN observation (logged-out composer) stays PENDING", async () => {
  // This is the live shape: the page renders a composer, but nothing proves a
  // session. It must behave exactly like NEEDS_AUTH, not like a dead browser.
  const step = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.UNKNOWN, attempt: 1, elapsedMs: 2_000 });
  assert.equal(step.state, AUTH_WAIT_STATE.PENDING);
  assert.equal(step.terminal, false);
  assert.equal(step.reason, "waiting-for-login");

  const loop = await runWait([AUTH_PROBE_STATE.UNKNOWN, AUTH_PROBE_STATE.UNKNOWN, AUTH_PROBE_STATE.READY]);
  assert.equal(loop.state, AUTH_WAIT_STATE.READY);
  assert.equal(loop.attempts, 3);
  assert.equal(loop.sleeps, 2);
});

test("V16.3 auth-wait NEEDS_AUTH does not terminate immediately", () => {
  for (const attempt of [1, 2, 5]) {
    const step = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.NEEDS_AUTH, attempt, elapsedMs: attempt * 2_000 });
    assert.equal(step.state, AUTH_WAIT_STATE.PENDING, `attempt ${attempt}`);
    assert.equal(step.terminal, false, `attempt ${attempt}`);
  }
  // An unknown observation is "not logged in yet", not a reason to give up.
  const unknown = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.UNKNOWN, attempt: 3, elapsedMs: 6_000 });
  assert.equal(unknown.state, AUTH_WAIT_STATE.PENDING);
});

test("V16.3 auth-wait UI_CHANGED becomes terminal only after a READY was seen", () => {
  const pending = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.UI_CHANGED, attempt: 4, elapsedMs: 8_000 });
  assert.equal(pending.state, AUTH_WAIT_STATE.PENDING);

  // Positive evidence of breakage: authenticated, then the UI stopped resolving.
  const afterReady = nextAuthWaitState({
    ...BASE,
    observation: AUTH_PROBE_STATE.UI_CHANGED,
    seenReady: true,
    attempt: 9,
    elapsedMs: 18_000,
  });
  assert.equal(afterReady.state, AUTH_WAIT_STATE.UI_CHANGED);
  assert.equal(afterReady.terminal, true);
  assert.equal(afterReady.reason, "authenticated-page-loaded-but-ui-unresolvable");
});

test("V16.3 auth-wait READY is terminal on any probe and reports whether it followed a wait", () => {
  const first = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.READY, attempt: 1, elapsedMs: 2_000 });
  assert.equal(first.state, AUTH_WAIT_STATE.READY);
  assert.equal(first.terminal, true);
  assert.equal(first.reason, "composer-positively-observed");

  // READY after a pending wait is a fresh login during this run.
  const later = nextAuthWaitState({
    ...BASE,
    observation: AUTH_PROBE_STATE.READY,
    seenReady: false,
    attempt: 11,
    elapsedMs: 22_000,
  });
  assert.equal(later.state, AUTH_WAIT_STATE.READY);
  assert.equal(later.reason, "composer-observed-after-pending");
  // READY on probe 1 means the persistent profile was already authenticated.
  assert.equal(first.reason, "composer-positively-observed");
});

test("V16.3 auth-wait a closed browser is its own terminal state", () => {
  const closed = nextAuthWaitState({ ...BASE, transportAlive: false, attempt: 6, elapsedMs: 12_000 });
  assert.equal(closed.state, AUTH_WAIT_STATE.BROWSER_CLOSED);
  assert.equal(closed.terminal, true);
  assert.equal(closed.reason, "browser-closed-by-user-or-exit");

  const withReason = nextAuthWaitState({
    ...BASE,
    transportAlive: false,
    closeReason: "worker-process-exited",
    attempt: 2,
    elapsedMs: 4_000,
  });
  assert.equal(withReason.reason, "worker-process-exited");

  // A dead lane must not masquerade as "not logged in yet".
  const noObservation = nextAuthWaitState({ ...BASE, observation: null, attempt: 1, elapsedMs: 10 });
  assert.equal(noObservation.state, AUTH_WAIT_STATE.BROWSER_CLOSED);
  assert.equal(noObservation.reason, "auth-probe-unavailable");
});

test("V16.3 auth-wait a hard navigation failure outranks every other signal", () => {
  const step = nextAuthWaitState({
    ...BASE,
    navigationOk: false,
    observation: AUTH_PROBE_STATE.READY,
    attempt: 1,
    elapsedMs: 500,
  });
  assert.equal(step.state, AUTH_WAIT_STATE.HARD_NAVIGATION_FAILURE);
  assert.equal(step.terminal, true);
  assert.equal(step.reason, "entry-navigation-failed");
});

test("V16.3 auth-wait times out on the probe bound and on the wall-clock bound", () => {
  const byProbes = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.NEEDS_AUTH, attempt: AUTH_WAIT_LIMIT.maxAttempts, elapsedMs: 1_000 });
  assert.equal(byProbes.state, AUTH_WAIT_STATE.TIMEOUT);
  assert.equal(byProbes.reason, "max-probes-reached");

  const byClock = nextAuthWaitState({ ...BASE, observation: AUTH_PROBE_STATE.NEEDS_AUTH, attempt: 3, elapsedMs: AUTH_WAIT_LIMIT.overallTimeoutMs });
  assert.equal(byClock.state, AUTH_WAIT_STATE.TIMEOUT);
  assert.equal(byClock.reason, "wall-clock-bound-reached");

  // Either bound alone is sufficient; there is no path that waits forever.
  const justUnder = nextAuthWaitState({
    ...BASE,
    observation: AUTH_PROBE_STATE.NEEDS_AUTH,
    attempt: AUTH_WAIT_LIMIT.maxAttempts - 1,
    elapsedMs: AUTH_WAIT_LIMIT.overallTimeoutMs - 1,
  });
  assert.equal(justUnder.state, AUTH_WAIT_STATE.PENDING);
});

test("V16.3 auth-wait limits are inside the required interval band and wall clock", () => {
  assert.ok(AUTH_WAIT_LIMIT.intervalMs >= 1_500 && AUTH_WAIT_LIMIT.intervalMs <= 2_500);
  assert.ok(AUTH_WAIT_LIMIT.minIntervalMs >= 1_500);
  assert.ok(AUTH_WAIT_LIMIT.maxIntervalMs <= 2_500);
  assert.equal(AUTH_WAIT_LIMIT.maxAttempts, 90);
  assert.equal(AUTH_WAIT_LIMIT.overallTimeoutMs, 180_000);
  assert.ok(AUTH_WAIT_LIMIT.overallTimeoutMs <= 180_000);
});

test("V16.3 auth-wait progress labels carry no page content", () => {
  const label = authWaitProgressLabel(AUTH_WAIT_STATE.PENDING, 7, AUTH_WAIT_LIMIT.maxAttempts);
  assert.equal(label, "probe  7/90: waiting-for-login");
  assert.ok(!/sign in|token|cookie|password/i.test(label));
  assert.equal(authWaitProgressLabel(AUTH_WAIT_STATE.READY, 90, 90), "probe 90/90: READY");
  assert.equal(authWaitProgressLabel(AUTH_WAIT_STATE.BROWSER_CLOSED, 3, 90), "probe  3/90: BROWSER_CLOSED");
  assert.equal(authWaitProgressLabel(AUTH_WAIT_STATE.TIMEOUT, 90, 90), "probe 90/90: TIMEOUT");
  assert.equal(authWaitProgressLabel(AUTH_WAIT_STATE.UI_CHANGED, 12, 90), "probe 12/90: UI_CHANGED");
});

// ---------------------------------------------------------------------------
// The wait LOOP, driven end to end with a fake worker
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the smoke's wait loop. It mirrors the real control flow:
 * observe -> advance the state machine -> return on terminal -> sleep otherwise.
 */
async function runWait(observations, options = {}) {
  const maxAttempts = Number(options.maxAttempts) || 10;
  const overallTimeoutMs = Number(options.overallTimeoutMs) || 60_000;
  let attempt = 0;
  let seenReady = false;
  let sleeps = 0;
  const sleepImpl = async () => { sleeps += 1; };
  while (true) {
    attempt += 1;
    const observation = observations[Math.min(attempt - 1, observations.length - 1)] ?? null;
    const step = nextAuthWaitState({
      observation,
      transportAlive: observation !== "__CLOSED__",
      navigationOk: true,
      seenReady,
      attempt,
      elapsedMs: attempt * 1_000,
      maxAttempts,
      overallTimeoutMs,
    });
    if (step.state === AUTH_WAIT_STATE.READY) return { ...step, attempts: attempt, sleeps };
    if (step.terminal) return { ...step, attempts: attempt, sleeps };
    await sleepImpl();
  }
}

test("V16.3 auth-wait the loop survives a first UI_CHANGED and succeeds on a later READY", async () => {
  const result = await runWait([
    AUTH_PROBE_STATE.UI_CHANGED,
    AUTH_PROBE_STATE.NEEDS_AUTH,
    AUTH_PROBE_STATE.UI_CHANGED,
    AUTH_PROBE_STATE.READY,
  ]);
  assert.equal(result.state, AUTH_WAIT_STATE.READY);
  assert.equal(result.attempts, 4);
  // Three sleeps for the three non-terminal probes: it paused, it did not spin.
  assert.equal(result.sleeps, 3);
});

test("V16.3 auth-wait the loop never spins: every non-terminal probe sleeps", async () => {
  const result = await runWait([AUTH_PROBE_STATE.NEEDS_AUTH], { maxAttempts: 5, overallTimeoutMs: 600_000 });
  assert.equal(result.state, AUTH_WAIT_STATE.TIMEOUT);
  assert.equal(result.attempts, 5);
  assert.equal(result.sleeps, 4, "sleep before every retry, never after the terminal probe");
  assert.equal(result.sleeps, result.attempts - 1);
});

test("V16.3 auth-wait the loop stops immediately when the browser closes", async () => {
  const result = await runWait([AUTH_PROBE_STATE.NEEDS_AUTH, "__CLOSED__", AUTH_PROBE_STATE.READY]);
  assert.equal(result.state, AUTH_WAIT_STATE.BROWSER_CLOSED);
  assert.equal(result.attempts, 2, "a later READY must not resurrect a closed browser");
  assert.equal(result.sleeps, 1);
});

test("V16.3 auth-wait the loop honours both bounds independently", async () => {
  const byProbes = await runWait([AUTH_PROBE_STATE.NEEDS_AUTH], { maxAttempts: 4, overallTimeoutMs: 600_000 });
  assert.equal(byProbes.reason, "max-probes-reached");

  const byClock = await runWait([AUTH_PROBE_STATE.NEEDS_AUTH], { maxAttempts: 90, overallTimeoutMs: 3_000 });
  assert.equal(byClock.reason, "wall-clock-bound-reached");
  assert.ok(byClock.attempts <= 4);
});

// ---------------------------------------------------------------------------
// Worker liveness (the BROWSER_CLOSED source)
// ---------------------------------------------------------------------------

test("V16.3 auth-wait the worker client reports a dead process instead of a hung probe", async () => {
  const listeners = [];
  const fakeProcess = {
    handlers: {},
    once(event, handler) { this.handlers[event] = handler; return this; },
    emit(event, value) { this.handlers[event]?.(value); },
  };
  const client = createBrowserWorkerClient({
    process: fakeProcess,
    transport: {
      send(message) {
        // The worker answers, so the probe exercises the LIVE path before the
        // process is killed. A silent fake would only ever test the timeout path.
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(encodeWorkerResponse({
              ok: true,
              requestId: message.requestId,
              operation: message.operation || BROWSER_WORKER_OPERATION.AUTH_PROBE,
              payload: { auth: { url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 1, text: "hi" } },
            }));
          }
        });
      },
      onMessage(listener) { listeners.push(listener); return () => {}; },
      close() {},
    },
  });
  assert.equal(client.isAlive(), true);
  /** @type {any} */
  let closeEvent = null;
  client.onClose((event) => { closeEvent = event; });

  const probe = await client.authProbe({ timeoutMs: 50 });
  assert.equal(probe.transportAlive, true);

  // The user closes the headed window: the worker exits.
  fakeProcess.emit("exit", 0);
  assert.equal(client.isAlive(), false);
  assert.equal(closeEvent?.reason, "worker-process-exited");
  const after = await client.authProbe({ timeoutMs: 50 });
  assert.equal(after.state, "closed");
  assert.equal(after.transportAlive, false);
  assert.equal(after.observations, null);
});

test("V16.3 auth-wait a client with no transport is never alive", async () => {
  const client = createBrowserWorkerClient({});
  assert.equal(client.isAlive(), false);
  const probe = await client.authProbe({});
  assert.equal(probe.transportAlive, false);
});

// ---------------------------------------------------------------------------
// Profile persistence and credential hygiene
// ---------------------------------------------------------------------------

test("V16.3 auth-wait the persistent profile is preserved across runs and holds no exported credential", async () => {
  const { profileForMode, DEEPSEEK_PROFILE_NAME } = await import("../lib/browser-profile.mjs");
  const resolved = profileForMode({ live: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(resolved.userDataDir.endsWith(path.join("browser-profiles", DEEPSEEK_PROFILE_NAME)), true);
  // Resolution is stable, so a later `--live` run targets the same directory.
  const again = profileForMode({ live: true, profile: DEEPSEEK_PROFILE_NAME });
  assert.equal(again.userDataDir, resolved.userDataDir);

  // The worker and the client expose no credential accessor at all.
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  for (const forbidden of ["storageState", "cookies()", "localStorage", "sessionStorage"]) {
    assert.ok(!worker.includes(forbidden), `worker must not read ${forbidden}`);
  }
  const client = createBrowserWorkerClient({});
  for (const forbidden of ["cookies", "storageState", "exportSession", "readToken", "credentials"]) {
    assert.equal(client[forbidden], undefined, `client must not expose ${forbidden}`);
  }

  // And the auth observation itself carries no credential-shaped field.
  const listeners = [];
  const live = createBrowserWorkerClient({
    transport: {
      send(message) {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(encodeWorkerResponse({
              ok: true,
              requestId: message.requestId,
              operation: message.operation || BROWSER_WORKER_OPERATION.AUTH_PROBE,
              payload: { auth: { url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 1, text: "hi" } },
            }));
          }
        });
      },
      onMessage(listener) { listeners.push(listener); return () => {}; },
      close() {},
    },
  });
  const probe = await live.authProbe({ timeoutMs: 50 });
  const serialized = JSON.stringify(probe);
  assert.ok(!/cookie|token|password|authorization/i.test(serialized));
  assert.equal(probe.state, AUTH_PROBE_STATE.READY);
});

// ---------------------------------------------------------------------------
// The smoke script really uses this machine
// ---------------------------------------------------------------------------

test("V16.3 auth-wait the smoke script drives the shared state machine", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  assert.ok(smoke.includes("nextAuthWaitState"));
  assert.ok(smoke.includes("authWaitProgressLabel"));
  assert.ok(smoke.includes("AUTH_WAIT_STATE.READY"));
  assert.ok(smoke.includes("AUTH_WAIT_STATE.BROWSER_CLOSED"));
  assert.ok(smoke.includes("AUTH_WAIT_STATE.UI_CHANGED"));
  assert.ok(smoke.includes("HARD_NAVIGATION_FAILURE"));
  assert.ok(smoke.includes("AUTH_READY"));
  // The regression itself: no bare UI_CHANGED early return.
  assert.ok(
    !/last\.state === AUTH_PROBE_STATE\.UI_CHANGED\) \{\s*\n\s*\/\/ A recognisable/.test(smoke),
    "the UI_CHANGED early-return that killed manual auth must be gone",
  );
});