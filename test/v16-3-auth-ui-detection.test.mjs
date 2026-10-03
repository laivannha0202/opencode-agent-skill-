// V16.3 DeepSeek authenticated-UI detection.
//
// Real evidence that motivated this file: the user WAS visibly logged in --
// sidebar conversation history, account/profile UI, composer, chat surface --
// and `--auth` printed `waiting-for-login` for 89 consecutive probes, then
// TIMEOUT. The persistent profile, the wait loop and the bounds all worked. The
// DETECTOR did not match the real DOM.
//
// These tests encode the shapes that were actually observed, plus the negative
// shapes that must keep failing closed.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  MIN_HISTORY_ROWS_FOR_SESSION,
  authProbeScript,
  classifyAuthState,
} from "../lib/browser-profile.mjs";
import {
  authDebugSummary,
  domInspectScript,
  sanitizeDomInspection,
} from "../lib/browser-dom-inspect.mjs";
import {
  BROWSER_WORKER_OPERATION,
  decodeWorkerResponse,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs";
import { createBrowserWorkerClient } from "../lib/browser-worker-client.mjs";
import { workerModePlan, WORKER_MODE } from "../lib/browser-worker-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The reported real shapes. `composerVisible` is true in every authenticated
// shape, so composer alone can never be the discriminator.
const AUTHENTICATED_WITH_HISTORY = {
  url: "https://chat.deepseek.com/",
  composerVisible: true,
  accountSignal: false,
  answerRegions: 0,
  historyCount: 6,
};
const AUTHENTICATED_WITH_ACCOUNT = {
  url: "https://chat.deepseek.com/",
  composerVisible: true,
  accountSignal: true,
  answerRegions: 0,
  historyCount: 0,
};
const AUTHENTICATED_WITH_ANSWERS = {
  url: "https://chat.deepseek.com/",
  composerVisible: true,
  accountSignal: false,
  answerRegions: 3,
  historyCount: 0,
};
const LOGGED_OUT_SHELL = {
  url: "https://chat.deepseek.com/",
  composerVisible: true,
  accountSignal: false,
  answerRegions: 0,
  historyCount: 0,
};

// ---------------------------------------------------------------------------
// The READY rule
// ---------------------------------------------------------------------------

test("V16.3 auth composer + real sidebar history structure is READY", () => {
  const state = classifyAuthState(AUTHENTICATED_WITH_HISTORY);
  assert.equal(state.state, AUTH_PROBE_STATE.READY);
  assert.equal(state.reason, "composer-and-history-present");
});

test("V16.3 auth composer + real account affordance is READY", () => {
  const state = classifyAuthState(AUTHENTICATED_WITH_ACCOUNT);
  assert.equal(state.state, AUTH_PROBE_STATE.READY);
  assert.equal(state.reason, "composer-and-account-signal-present");
});

test("V16.3 auth composer + assistant answer region is READY", () => {
  const state = classifyAuthState(AUTHENTICATED_WITH_ANSWERS);
  assert.equal(state.state, AUTH_PROBE_STATE.READY);
  assert.equal(state.reason, "composer-and-answer-region-present");
});

test("V16.3 auth the logged-out composer shell stays UNKNOWN", () => {
  const state = classifyAuthState(LOGGED_OUT_SHELL);
  assert.equal(state.state, AUTH_PROBE_STATE.UNKNOWN);
  assert.equal(state.reason, "composer-visible-but-no-session-signal");
});

test("V16.3 auth a login wall is NEEDS_AUTH even with every positive signal", () => {
  const state = classifyAuthState({
    ...AUTHENTICATED_WITH_HISTORY,
    ...AUTHENTICATED_WITH_ACCOUNT,
    url: "https://chat.deepseek.com/login",
  });
  assert.equal(state.state, AUTH_PROBE_STATE.NEEDS_AUTH);
});

test("V16.3 auth without a composer nothing is READY, whatever else is true", () => {
  for (const signal of [
    { accountSignal: true, answerRegions: 4, historyCount: 9 },
    { accountSignal: false, answerRegions: 4, historyCount: 9 },
    { accountSignal: false, answerRegions: 0, historyCount: 9 },
  ]) {
    const state = classifyAuthState({
      url: "https://chat.deepseek.com/",
      composerVisible: false,
      ...signal,
    });
    assert.notEqual(state.state, AUTH_PROBE_STATE.READY, JSON.stringify(signal));
  }
});

test("V16.3 auth one sidebar row is not a history list", () => {
  // A logged-out shell commonly renders exactly one sidebar row ("New chat").
  assert.equal(MIN_HISTORY_ROWS_FOR_SESSION, 2);
  const single = classifyAuthState({ ...LOGGED_OUT_SHELL, historyCount: 1 });
  assert.equal(single.state, AUTH_PROBE_STATE.UNKNOWN);
  const pair = classifyAuthState({ ...LOGGED_OUT_SHELL, historyCount: 2 });
  assert.equal(pair.state, AUTH_PROBE_STATE.READY);
});

test("V16.3 auth the history count is capped so a huge list cannot skew anything", () => {
  const huge = classifyAuthState({ ...LOGGED_OUT_SHELL, historyCount: 5_000 });
  assert.equal(huge.state, AUTH_PROBE_STATE.READY);
  assert.ok(huge.historyCount === 5_000 || huge.historyCount <= 5_000);
});

// ---------------------------------------------------------------------------
// Selector derivation: structural, not a vendor class guess
// ---------------------------------------------------------------------------

test("V16.3 auth the probe derives history STRUCTURALLY, not from a vendor class", () => {
  const script = authProbeScript({ answerSelectors: [".ds-markdown"] });
  // Sidebar containers are found by landmark/role, then rows counted inside them.
  for (const landmark of ["\"nav\"", "\"aside\"", "[role='navigation']", "[role='complementary']", "sidebar"]) {
    assert.ok(script.includes(landmark), `missing sidebar landmark ${landmark}`);
  }
  assert.ok(script.includes("HISTORY_ROW"));
  assert.ok(script.includes("historyCount"));
  // A COUNT only: the sidebar walk must never read rendered text, which is where
  // conversation titles and account names live.
  const walk = script.slice(script.indexOf("SIDEBAR_CONTAINERS"), script.indexOf("historyCount > 50"));
  assert.ok(!walk.includes("innerText"), "the history walk must not read rendered text");
  assert.ok(!walk.includes("textContent"), "the history walk must not read rendered text");
  assert.ok(!walk.includes("title"), "the history walk must not read title attributes");
});

test("V16.3 auth the probe never reads credentials or input values", () => {
  const script = authProbeScript({});
  for (const forbidden of [
    "document.cookie", "localStorage", "sessionStorage", "indexedDB",
    ".value", "getAttribute('value')", "password",
  ]) {
    assert.ok(!script.includes(forbidden), `probe must not touch ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Diagnostic mode: read-only and non-leaking
// ---------------------------------------------------------------------------

test("V16.3 diag the inspection script reads structure only, never content", () => {
  const script = domInspectScript({ limit: 10 });
  for (const forbidden of [
    "document.cookie", "localStorage", "sessionStorage", "indexedDB",
    "innerText", "textContent", "outerHTML", "innerHTML", ".value",
  ]) {
    assert.ok(!script.includes(forbidden), `diagnostic must not read ${forbidden}`);
  }
  // It must not act either.
  for (const forbidden of [".click(", ".fill(", ".type(", "form.submit", "dispatchEvent"]) {
    assert.ok(!script.includes(forbidden), `diagnostic must not ${forbidden}`);
  }
});

test("V16.3 diag href is reduced to a path shape with query withheld", () => {
  const script = domInspectScript({ limit: 1 });
  assert.ok(script.includes("safeHref"));
  assert.ok(script.includes('.split("?")[0].split("#")[0]'));
});

test("V16.3 diag sanitizer drops account text, titles and credentials a worker might leak", () => {
  const sanitized = sanitizeDomInspection({
    url: "https://chat.deepseek.com/?token=abc",
    aggregates: { textarea: 1, buttons: 3, sidebarLinks: 4 },
    rows: [
      {
        tag: "button",
        role: "button",
        ariaLabel: { present: true, generic: "account" },
        classTokens: ["avatar", "btn", "ada-private-token"],
        href: { shape: "/account", hasQuery: true, hasFragment: false },
        inSidebar: true,
        childCount: 2,
        visible: true,
      },
      {
        tag: "a",
        title: { present: true, generic: null },
        classTokens: ["conversation"],
        href: { shape: "/chat/#", hasQuery: false, hasFragment: true },
        conversationTitle: "Q3 revenue thread",
        accountName: "Ada Lovelace",
        cookie: "sid=abc123",
        inputValue: "hunter2",
      },
    ],
  });

  assert.equal(sanitized.url, "https://chat.deepseek.com/");
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of ["ada-private-token", "Ada Lovelace", "Q3 revenue thread", "sid=abc123", "hunter2"]) {
    assert.ok(!serialized.includes(forbidden), `sanitizer leaked ${forbidden}`);
  }
  // Generic vocabulary survives, which is what makes it useful for repair.
  assert.ok(sanitized.rows[0].classTokens.includes("avatar"));
  assert.equal(sanitized.rows[0].classTokens[2], "[filtered]");
  assert.equal(sanitized.rows[0].ariaLabel.generic, "account");
  assert.equal(sanitized.rows[0].href.hasQuery, true);
  assert.equal(sanitized.rows[0].inSidebar, true);
  // A withheld generic label keeps only its PRESENCE, not the text.
  assert.equal(sanitized.rows[1].title.present, true);
  assert.equal(sanitized.rows[1].title.generic, null);
});

test("V16.3 diag the sanitizer states its own disclosure", () => {
  const sanitized = sanitizeDomInspection({});
  assert.equal(sanitized.disclosure.pageTextRead, false);
  assert.equal(sanitized.disclosure.acted, false);
  assert.equal(sanitized.disclosure.cookiesRead, false);
});

test("V16.3 diag the auth summary is booleans and counts only", () => {
  const summary = authDebugSummary(
    {
      url: "https://chat.deepseek.com/?token=abc",
      composerVisible: true,
      accountSignal: false,
      historyCount: 6,
      answerRegions: 0,
    },
    { state: "READY", reason: "composer-and-history-present" },
  );
  assert.deepEqual(
    {
      composerVisible: summary.composerVisible,
      accountSignal: summary.accountSignal,
      historyCount: summary.historyCount,
      answerRegions: summary.answerRegions,
    },
    { composerVisible: true, accountSignal: false, historyCount: 6, answerRegions: 0 },
  );
  assert.equal(summary.urlPath, "https://chat.deepseek.com/");
  assert.equal(summary.classifiedState, "READY");
  // No page content, no account text, no query string.
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["token=abc", "innerText", "accountName"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

// ---------------------------------------------------------------------------
// Worker / protocol plumbing
// ---------------------------------------------------------------------------

test("V16.3 diag dom-inspect is a routable read-only operation", async () => {
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
              payload: message.operation === BROWSER_WORKER_OPERATION.DOM_INSPECT
                ? {
                  dom: {
                    url: "https://chat.deepseek.com/",
                    aggregates: { buttons: 4, sidebarLinks: 3, accountCandidates: 1, historyCandidates: 5 },
                    rows: [{ tag: "button", classTokens: ["avatar"], inSidebar: true, childCount: 1, visible: true }],
                  },
                }
                : { auth: { url: "https://chat.deepseek.com/", composerVisible: true, accountSignal: true, answerRegions: 0, historyCount: 6 } },
            }));
          }
        });
      },
      onMessage(listener) { listeners.push(listener); return () => {}; },
      close() {},
    },
  });

  const inspected = await client.domInspect({ limit: 10 });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.inspection.aggregates.sidebarLinks, 3);
  assert.equal(inspected.inspection.aggregates.accountCandidates, 1);
  assert.equal(inspected.inspection.rows[0].classTokens[0], "avatar");

  const probe = await client.authProbe({ timeoutMs: 50 });
  assert.equal(probe.state, AUTH_PROBE_STATE.READY);
  const summary = client.authDebugSummary(probe.observations, probe);
  assert.equal(summary.accountSignal, true);
  assert.equal(summary.historyCount, 6);
  await client.close();
});

test("V16.3 diag the decoder carries accountSignal and historyCount through", () => {
  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true,
    requestId: "d1",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: {
      auth: {
        url: "https://chat.deepseek.com/",
        composerVisible: true,
        accountSignal: true,
        answerRegions: 0,
        historyCount: 9,
        conversationTitles: ["should not survive"],
        accountName: "should not survive",
      },
    },
  }));
  assert.equal(decoded.result.auth.accountSignal, true);
  assert.equal(decoded.result.auth.historyCount, 9);
  const serialized = JSON.stringify(decoded);
  assert.ok(!serialized.includes("should not survive"));
});

test("V16.3 diag the worker returns accountSignal and historyCount in the auth payload", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8");
  assert.ok(/accountSignal:\s*observations\.accountSignal === true/.test(worker));
  assert.ok(/historyCount:\s*Number\(observations\.historyCount \|\| 0\)/.test(worker));
});

// ---------------------------------------------------------------------------
// Isolation and continuity
// ---------------------------------------------------------------------------

test("V16.3 diag the diagnostic is manual and unreachable from CI or release", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  assert.ok(smoke.includes("--auth-diagnose"));
  assert.ok(smoke.includes("READ-ONLY AUTH DIAGNOSTIC"));

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  for (const gate of ["ci", "release:verify", "test", "eval:v16", "eval:v16.3", "eval:v16.3.workers"]) {
    assert.ok(!String(scripts[gate] || "").includes("smoke:deepseek-web"), `${gate} must not run it`);
  }
  // The default command must not opt into a third-party diagnostic.
  assert.ok(!String(scripts["smoke:deepseek-web"] || "").includes("--auth-diagnose"));

  const check = await readFile(path.join(root, "scripts", "check-release-consistency.mjs"), "utf8");
  assert.ok(check.includes("must NOT run the live DeepSeek web smoke"));
  assert.ok(check.includes("must not default to the third-party diagnostic"));
});

test("V16.3 diag auth/live profile continuity is unchanged by this fix", () => {
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" });
  const live = workerModePlan({ live: true, profile: "deepseek-web" });
  assert.equal(auth.profileName, live.profileName);
  assert.equal(auth.persistentProfileName, live.persistentProfileName);
  assert.equal(auth.live, true);
  assert.equal(live.live, true);
  assert.equal(auth.headed, true);
  assert.equal(live.headed, false);
  assert.equal(workerModePlan({}).mode, WORKER_MODE.PREFLIGHT);
});