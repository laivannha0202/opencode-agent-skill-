// V16.3 LIVE DeepSeek hardening: persistent profile, real auth gate, session
// preconditions.
//
// Every test here is deterministic and browser-free. The live smoke is not: it is
// manually gated and MUST NOT appear in `ci` or `release:verify`, which the last
// two tests prove by reading package.json rather than by trusting a comment.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  BROWSER_PROFILE_MODES,
  BROWSER_PROFILE_REASON,
  DEEPSEEK_PROFILE_NAME,
  authProbeScript,
  browserProfilesRoot,
  classifyAuthState,
  profileForMode,
  safeProfileName,
} from "../lib/browser-profile.mjs"
import {
  BROWSER_WORKER_FAILURE,
  BROWSER_WORKER_OPERATION,
  decodeWorkerResponse,
  encodeWorkerRequest,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs"
import { AUTH_PROBE_STATE as CLIENT_AUTH_STATE, createBrowserWorkerClient } from "../lib/browser-worker-client.mjs"
import {
  DEEPSEEK_WEB_FAILURE,
  DEEPSEEK_WEB_STATE,
  createDeepSeekWebAdapter,
  probeAuthState,
  probeSessionHealth,
} from "../lib/deepseek-web-adapter.mjs"
import { preflightBrowserCapability } from "../lib/browser-capability.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLICK = "mcp__playwright__browser_click";
const FILL = "mcp__playwright__browser_fill_form";
const SNAP = "mcp__playwright__browser_snapshot";
const NAVIGATE = "mcp__playwright__browser_navigate";

// ---------------------------------------------------------------------------
// Persistent profile
// ---------------------------------------------------------------------------

test("V16.3 live the persistent profile lives outside the repository and is created on demand", () => {
  const rootDir = browserProfilesRoot(path.join("C:", "Users", "Tester", ".config", "ues"));
  assert.ok(rootDir.includes(path.join("browser-profiles")));

  const live = profileForMode({ live: true, profile: DEEPSEEK_PROFILE_NAME, configDir: path.join("C:", "tmp", "uescfg") });
  assert.equal(live.mode, BROWSER_PROFILE_MODES.PERSISTENT);
  assert.equal(live.reason, BROWSER_PROFILE_REASON.RESOLVED);
  assert.ok(live.userDataDir.endsWith(path.join("browser-profiles", DEEPSEEK_PROFILE_NAME)));
  // A profile under the UES config dir can never be swept into the workspace
  // snapshot, a diff, or a commit: it is not inside the project at all.
  assert.ok(!path.isAbsolute(live.userDataDir) || !live.userDataDir.startsWith(root));
  assert.equal(live.exists, false, "resolve reports metadata only; it does not create the directory");
});

test("V16.3 live an ephemeral context is used for every non-live mode, which is what CI gets", () => {
  for (const mode of [{}, { live: false, profile: DEEPSEEK_PROFILE_NAME }, { live: true, profile: "" }]) {
    const resolved = profileForMode(mode);
    assert.equal(resolved.userDataDir, null, JSON.stringify(mode));
    assert.equal(resolved.mode, BROWSER_PROFILE_MODES.EPHEMERAL);
  }
  assert.equal(
    profileForMode({ live: false, profile: "x" }).reason,
    BROWSER_PROFILE_REASON.NOT_LIVE,
  );
  assert.equal(
    profileForMode({ live: true, profile: "" }).reason,
    BROWSER_PROFILE_REASON.NO_NAME,
  );
  // An explicit opt-out still wins, so an operator can forbid persistence.
  assert.equal(
    profileForMode({ live: true, profile: "x", persistent: false }).reason,
    BROWSER_PROFILE_REASON.DISABLED,
  );
});

test("V16.3 live a hostile profile name cannot escape the profiles root", () => {
  assert.equal(safeProfileName("deepseek-web"), "deepseek-web");
  assert.equal(safeProfileName("../../escape"), safeProfileName("../../escape"));
  assert.ok(!safeProfileName("../../escape").includes(".."));
  assert.ok(safeProfileName("../../escape").startsWith("p-"));
  assert.equal(safeProfileName(""), "default");
  // Deterministic: the same hostile input always maps to the same directory.
  assert.equal(safeProfileName("../../escape"), safeProfileName("../../escape"));
  const resolved = profileForMode({ live: true, profile: "../../escape", configDir: path.join("C:", "tmp", "cfg") });
  assert.ok(resolved.userDataDir.startsWith(browserProfilesRoot(path.join("C:", "tmp", "cfg"))));
});

test("V16.3 live the worker profile capability reports a path and a mode, never contents", async () => {
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
              payload: message.operation === BROWSER_WORKER_OPERATION.CAPABILITY
                ? {
                  playwright: "available",
                  browserState: "ready",
                  interactive: true,
                  profileMode: "persistent",
                  profileDir: "C:/Users/T/.config/ues/browser-profiles/deepseek-web",
                  profileExists: true,
                  headless: false,
                }
                : { auth: { url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 2, text: "hello" } },
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
  assert.equal(capability.headless, false);
  // The capability is a directory path, never profile contents.
  assert.ok(!JSON.stringify(capability).toLowerCase().includes("cookie"));
  const probe = await client.authProbe({});
  assert.equal(probe.state, AUTH_PROBE_STATE.READY);
  assert.equal(probe.probeOnly, true);
  await client.close();
});

// ---------------------------------------------------------------------------
// Auth probe (real DOM/URL evidence)
// ---------------------------------------------------------------------------

test("V16.3 live a logged-in page classifies READY from real evidence", () => {
  const loggedIn = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "New chat  |  DeepSeek\nAsk anything",
    composerVisible: true,
    answerRegions: 3,
  });
  assert.equal(loggedIn.state, AUTH_PROBE_STATE.READY);
  assert.equal(loggedIn.reason, "composer-and-answer-region-present");

  const withAccount = classifyAuthState({ url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 0, accountSignal: true });
  assert.equal(withAccount.state, AUTH_PROBE_STATE.READY);
  assert.equal(withAccount.reason, "composer-and-account-signal-present");
});

test("V16.3 live a composer with no session signal is NOT logged in (observed live regression)", () => {
  // Observed against the real logged-out landing page: it renders a full prompt
  // box ("Whenever you're ready") and zero assistant answer regions. The previous
  // rule read that as READY on probe 1, which would have submitted a prompt into
  // a logged-out shell. A composer is necessary but not sufficient.
  const loggedOutShell = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "New chat Whenever you're ready DeepThink Search",
    composerVisible: true,
    answerRegions: 0,
    accountSignal: false,
  });
  assert.equal(loggedOutShell.state, AUTH_PROBE_STATE.UNKNOWN);
  assert.equal(loggedOutShell.reason, "composer-visible-but-no-session-signal");

  // Either positive signal is sufficient on its own.
  assert.equal(
    classifyAuthState({ url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 2, accountSignal: false }).state,
    AUTH_PROBE_STATE.READY,
  );
  assert.equal(
    classifyAuthState({ url: "https://chat.deepseek.com/", composerVisible: true, answerRegions: 0, accountSignal: true }).state,
    AUTH_PROBE_STATE.READY,
  );
});

test("V16.3 live a login wall classifies NEEDS_AUTH from the URL and from page text", () => {
  const byUrl = classifyAuthState({
    url: "https://chat.deepseek.com/login",
    text: "",
    composerVisible: false,
  });
  assert.equal(byUrl.state, AUTH_PROBE_STATE.NEEDS_AUTH);
  assert.equal(byUrl.reason, "login-url-detected");

  const byText = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "Sign in to continue using DeepSeek",
    composerVisible: false,
  });
  assert.equal(byText.state, AUTH_PROBE_STATE.NEEDS_AUTH);
  assert.equal(byText.reason, "login-wall-detected-in-page-text");

  // A login wall beats a visible composer: a stale page object must not read READY.
  const walledWithComposer = classifyAuthState({
    url: "https://chat.deepseek.com/signin",
    text: "please log in",
    composerVisible: true,
  });
  assert.equal(walledWithComposer.state, AUTH_PROBE_STATE.NEEDS_AUTH);
});

test("V16.3 live UI drift and timeout are distinct, reported states", () => {
  const drift = classifyAuthState({
    url: "https://chat.deepseek.com/",
    text: "Welcome",
    composerVisible: false,
    answerRegions: 0,
  });
  assert.equal(drift.state, AUTH_PROBE_STATE.UI_CHANGED);
  assert.equal(drift.reason, "page-loaded-but-no-known-composer-found");

  const timeout = classifyAuthState({ timedOut: true, url: "https://chat.deepseek.com/" });
  assert.equal(timeout.state, AUTH_PROBE_STATE.TIMEOUT);

  const nothing = classifyAuthState({});
  assert.equal(nothing.state, AUTH_PROBE_STATE.UNKNOWN);
});

test("V16.3 live the auth probe script is read-only and returns no credential", () => {
  const script = authProbeScript({ answerSelectors: [".ds-markdown"], composerSelector: "#composer" });
  assert.ok(script.includes("composerVisible"));
  assert.ok(script.includes("answerRegions"));
  assert.ok(script.includes("innerText"));
  // Comments are stripped first: the script documents its own safety with the word
  // "values", and a raw substring search would flag the comment that promises the
  // property the assertion is checking. Code-only matching is what makes this test
  // about behaviour rather than about wording.
  // Comments are stripped first: the script documents its own safety with the
  // word 'values', and a raw substring search would flag the very comment that
  // promises the property this assertion checks. Code-only matching is what
  // makes the test about behaviour rather than about wording.
  const code = script.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of [
    "document.cookie",
    "localStorage",
    "sessionStorage",
    ".click(",
    ".fill(",
    ".value",
    ".setValue(",
    "type(",
  ]) {
    assert.ok(!code.includes(forbidden), `auth probe must not touch ${forbidden}`);
  }
});

test("V16.3 live the auth probe crosses the worker boundary without leaking secrets", () => {
  const encoded = encodeWorkerRequest({
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    requestId: "a1",
    answerSelectors: ["[data-message-role='assistant']"],
  });
  assert.equal(encoded.ok, true);
  // Only selectors travel outbound; never values.
  assert.ok(!("text" in encoded.payload));
  assert.deepEqual(encoded.payload.answerSelectors, ["[data-message-role='assistant']"]);

  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true,
    requestId: "a1",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: {
      auth: {
        url: "https://chat.deepseek.com/",
        title: "DeepSeek",
        text: "hello",
        composerVisible: true,
        answerRegions: 1,
        // A worker that wrongly included these would be scrubbed anyway.
        cookie: "sid=abc123",
        localStorageToken: "tok_abcdef",
      },
    },
  }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.result.auth.composerVisible, true);
  const serialized = JSON.stringify(decoded);
  assert.ok(!serialized.includes("sid=abc123"), "a cookie must never survive the decoder");
  assert.ok(!/"cookie"/.test(serialized), "the decoder must not carry a cookie field at all");
  assert.ok(!/"localStorageToken"/.test(serialized));
});

test("V16.3 live the adapter refuses to claim READY with no probe bound", async () => {
  const adapter = createDeepSeekWebAdapter({
    capability: { interactive: true, provider: "browser-worker" },
    invoke: async () => ({ ok: true }),
  });
  const capability = await adapter.capability();
  assert.equal(capability.state, "needs-auth");
  assert.equal(capability.authState, "UNKNOWN");
  assert.equal(capability.reason, DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED);

  const session = await adapter.startSession({});
  assert.equal(session.state, DEEPSEEK_WEB_STATE.NEEDS_AUTH);
  assert.equal(session.sessionId, null);
});

// ---------------------------------------------------------------------------
// Session preconditions
// ---------------------------------------------------------------------------

function lane(overrides = {}) {
  const capability = preflightBrowserCapability({
    tools: [SNAP, CLICK, FILL, NAVIGATE],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  });
  return createDeepSeekWebAdapter({ capability, invoke: async () => ({ ok: true }), ...overrides });
}

test("V16.3 live a new session navigates the entry URL before any prompt is typed", async () => {
  const order = [];
  const adapter = lane({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    invoke: async (action) => {
      order.push(action);
      if (action === "navigate") return { ok: true, beforeUrl: "about:blank", afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 10 };
      return { ok: true, afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
    },
  });
  const session = await adapter.startSession({});
  assert.equal(session.state, DEEPSEEK_WEB_STATE.READY);
  assert.equal(session.navigationPassed, true);
  assert.equal(session.authState, "READY");
  // The entry navigation happens during startSession, before any fill.
  assert.deepEqual(order, ["navigate"]);
  assert.equal(session.openedUrl, "https://chat.deepseek.com/");
});

test("V16.3 live a session that could not navigate is refused before the prompt", async () => {
  const order = [];
  const adapter = lane({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async (action) => {
      order.push(action);
      return { ok: false, error: "net::ERR_NAME_NOT_RESOLVED" };
    },
  });
  const session = await adapter.startSession({});
  assert.equal(session.state, DEEPSEEK_WEB_STATE.UI_CHANGED);
  assert.equal(session.sessionId, null);
  assert.equal(session.navigationPassed, false);
  assert.match(session.reason, /entry-navigation/);
  assert.deepEqual(order, ["navigate"], "a failed navigation must not be followed by a fill or a submit");
});

test("V16.3 live a login wall at start-up is NEEDS_AUTH and stops the run", async () => {
  const adapter = lane({
    authProbe: async () => ({ state: "NEEDS_AUTH", url: "https://chat.deepseek.com/login", reason: "login-url-detected" }),
    invoke: async (action) => (action === "navigate"
      ? { ok: true, afterUrl: "https://chat.deepseek.com/login" }
      : { ok: true }),
  });
  const session = await adapter.startSession({});
  assert.equal(session.state, DEEPSEEK_WEB_STATE.NEEDS_AUTH);
  assert.equal(session.sessionId, null);
  assert.equal(session.reason, DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED);
  assert.equal(session.authUrl, "https://chat.deepseek.com/login");

  // A follow-up against a session that never became ready is refused too.
  const followUp = await adapter.followUp({ state: DEEPSEEK_WEB_STATE.NEEDS_AUTH });
  assert.equal(followUp.ok, false);
});

test("V16.3 live a reused session is health-checked and rejected when it is not READY", async () => {
  let probes = 0;
  const adapter = lane({
    authProbe: async () => {
      probes += 1;
      return { state: "NEEDS_AUTH", url: "https://chat.deepseek.com/login", reason: "session expired" };
    },
    invoke: async (action) => (action === "navigate"
      ? { ok: true, afterUrl: "https://chat.deepseek.com/login" }
      : { ok: true }),
  });
  const session = await adapter.startSession({ reuseSessionId: "dsw-prev" });
  assert.equal(session.state, DEEPSEEK_WEB_STATE.NEEDS_AUTH);
  assert.equal(session.reused, true);
  assert.match(session.reason, /reused-session-unhealthy|auth-required/);
  assert.ok(probes >= 1, "a reused session must be probed before it is adopted");
});

test("V16.3 live probeSessionHealth passes only on an explicit READY observation", async () => {
  const ready = await probeSessionHealth({ deps: { authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }) } });
  assert.equal(ready.ok, true);

  for (const state of ["NEEDS_AUTH", "UI_CHANGED", "TIMEOUT", "UNKNOWN"]) {
    const result = await probeSessionHealth({ deps: { authProbe: async () => ({ state }) } });
    assert.equal(result.ok, false, state);
    assert.equal(result.session.healthPassed, false, state);
    assert.equal(result.session.sessionId, null, state);
  }

  const withNoProbe = await probeSessionHealth({ deps: {} });
  assert.equal(withNoProbe.ok, false);
  assert.equal(withNoProbe.auth.state, "UNKNOWN");
});

test("V16.3 live probeAuthState prefers the browser probe over an embedder probe", async () => {
  const browser = await probeAuthState({
    deps: {
      authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
      loginProbe: async () => ({ authenticated: false }),
    },
  });
  assert.equal(browser.state, "READY");
  assert.equal(browser.source, "browser-auth-probe");

  const embedder = await probeAuthState({ deps: { loginProbe: async () => ({ authenticated: true }) } });
  assert.equal(embedder.state, "READY");
  assert.equal(embedder.source, "embedder-login-probe");

  const throwing = await probeAuthState({
    deps: { authProbe: async () => { throw new Error("probe exploded") } },
  });
  assert.equal(throwing.state, "TIMEOUT");
  assert.match(throwing.reason, /auth-probe-threw/);
});

test("V16.3 live a session without confirmed navigation cannot submit", async () => {
  let submits = 0;
  const adapter = lane({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async (action) => {
      if (action === "click") submits += 1;
      return { ok: true };
    },
  });
  const unverified = { sessionId: "s", state: DEEPSEEK_WEB_STATE.READY, submitGuard: undefined, authState: "READY" };
  const typed = await adapter.consult(unverified, { rendered: "packet" }, { requestId: "r1" });
  assert.equal(typed.ok, false);
  assert.match(typed.failure, /navigation-not-confirmed/);
  assert.equal(submits, 0, "no prompt and no submit may happen without a confirmed navigation");
});

test("V16.3 live a session whose auth state is not READY cannot submit", async () => {
  let acts = 0;
  const adapter = lane({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async () => {
      acts += 1;
      return { ok: true };
    },
  });
  const guarded = {
    sessionId: "s",
    state: DEEPSEEK_WEB_STATE.READY,
    navigationPassed: true,
    authState: "NEEDS_AUTH",
  };
  const typed = await adapter.consult(guarded, { rendered: "packet" }, { requestId: "r2" });
  assert.equal(typed.ok, false);
  assert.equal(typed.failure, DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED);
  assert.equal(acts, 0);
});

// ---------------------------------------------------------------------------
// Duplicate submit with the live preconditions satisfied
// ---------------------------------------------------------------------------

test("V16.3 live a ready session submits once and a duplicate is refused", async () => {
  let sends = 0;
  const adapter = lane({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    invoke: async (action) => {
      if (action === "click") sends += 1;
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" };
      if (action === "fill") return { ok: true, filledChars: 20 };
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true };
      if (action === "snapshot") {
        return { ok: true, result: { answer: JSON.stringify({ summary: "s", hypotheses: [], recommendedApproach: [], filesToInspect: [], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.5 }) } };
      }
      return { ok: true };
    },
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
  });
  const session = await adapter.startSession({});
  assert.equal(session.state, DEEPSEEK_WEB_STATE.READY);

  const first = await adapter.consult(session, { rendered: "packet-one" }, { requestId: "req-1" });
  assert.equal(first.ok, true);
  assert.equal(sends, 1);

  // The same request replayed is refused by the session's submit guard.
  const replay = await adapter.consult(session, { rendered: "packet-one" }, { requestId: "req-1" });
  assert.equal(replay.ok, false);
  assert.equal(sends, 1, "a duplicate prompt must never produce a second submit");
});

// ---------------------------------------------------------------------------
// CI / release gating (behavioural, read from package.json)
// ---------------------------------------------------------------------------

test("V16.3 live the headed auth mode is manual only and never reachable from CI", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  // `--auth` exists, and it is gated behind an explicit flag rather than a default.
  assert.ok(smoke.includes("--auth"));
  assert.ok(smoke.includes("AUTH_POLL"));
  // The HEADED decision now lives in the mode plan, so assert the BEHAVIOUR
  // (auth is headed, live is not) instead of a literal in the script body.
  const { workerModePlan, WORKER_MODE } = await import("../lib/browser-worker-mode.mjs");
  assert.equal(workerModePlan({ auth: true }).headed, true);
  assert.ok(workerModePlan({ auth: true }).scriptArgs.includes("--headed"));
  assert.equal(workerModePlan({ live: true }).headed, false);
  assert.equal(workerModePlan({}).headed, false);
  // The login wait is bounded in both directions.
  assert.ok(smoke.includes("maxAttempts"));
  assert.ok(smoke.includes("overallTimeoutMs"));
  // It must not attempt to solve, bypass or auto-submit a login.
  for (const forbidden of ["captcha", "bypassLogin", "autoLogin", "solveChallenge"]) {
    const present = smoke.toLowerCase().includes(forbidden.toLowerCase());
    assert.ok(!present || smoke.toLowerCase().includes("does not bypass"), forbidden);
  }

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  assert.equal(scripts["smoke:deepseek-web"], "node scripts/smoke-deepseek-web-v16-3.mjs");
  // The live smoke must be unreachable from every automated gate.
  for (const gate of ["ci", "release:verify", "test", "eval:v16", "eval:v16.3"]) {
    assert.ok(!String(scripts[gate] || "").includes("smoke:deepseek-web"), `${gate} must not run the live smoke`);
  }
  assert.equal(scripts.prepublishOnly, "npm run release:verify");
});

test("V16.3 live the release gate actively forbids the live smoke from CI", async () => {
  const check = await readFile(path.join(root, "scripts", "check-release-consistency.mjs"), "utf8");
  assert.ok(check.includes("ci must NOT run the live DeepSeek web smoke"));
  assert.ok(check.includes("release:verify must NOT run the live DeepSeek web smoke"));
  assert.ok(check.includes("smoke-deepseek-web-v16-3.mjs"));
});

test("V16.3 live the worker cannot be turned into a profile-free or CI-visible lane by accident", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  // The persistent context is only reachable behind an explicit --live flag.
  assert.ok(worker.includes("profileForMode"));
  assert.ok(worker.includes("launchPersistentContext"));
  assert.ok(worker.includes("liveFlag"));
  // The worker never reads cookies or storage back out.
  for (const forbidden of ["storageState", "cookies()", "localStorage", "sessionStorage"]) {
    assert.ok(!worker.includes(forbidden), `worker must not read ${forbidden}`);
  }
});

test("V16.3 live the worker client exposes the auth probe but never a credential accessor", () => {
  const client = createBrowserWorkerClient({});
  assert.equal(typeof client.authProbe, "function");
  for (const forbidden of ["cookies", "storageState", "exportSession", "readToken"]) {
    assert.equal(client[forbidden], undefined, `client must not expose ${forbidden}`);
  }
  assert.equal(CLIENT_AUTH_STATE.READY, "READY");
  assert.equal(BROWSER_WORKER_FAILURE.CLOSED, "browser-worker-closed");
});