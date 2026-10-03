// V16.3 DeepSeek authenticated-history detector, driven by MEASURED evidence.
//
// The read-only diagnostic against the real persisted profile reported:
//     nav = 0, aside = 0, roleList = 0, roleListItem = 0, sidebarLinks = 0,
//     accountCandidates = 0, historyCandidates = 0, totalElements = 965
// while listing ~15 anchors with href path shape /a/chat/s/...
//
// So the DeepSeek sidebar is plain DIV structure with no landmark, list role or
// sidebar class. Every landmark-based detector returns 0 on the real UI, which is
// why an authenticated profile was reported UNKNOWN for 89 consecutive probes.
//
// These tests use a real browser against a LOCAL fixture that reproduces the
// measured shape. No network, no DeepSeek.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  MIN_HISTORY_ROWS_FOR_SESSION,
  authProbeScript,
  classifyAuthState,
} from "../lib/browser-profile.mjs";
import {
  BROWSER_WORKER_OPERATION,
  decodeWorkerResponse,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs";

const requireFromProject = createRequire(import.meta.url.replace(/test[/\\].*$/, "package.json"));

const CHAT_PATH = "/a/chat/s/";

// --- fixture -----------------------------------------------------------------

const chatAnchors = (n, { hidden = false, prefix = "" } = {}) =>
  Array.from({ length: n }, (_, i) =>
    `<a class="row${i}"${hidden ? ' style="display:none"' : ""} href="${prefix}/a/chat/s/6f1c${String(i).padStart(4, "0")}-1111-2222-3333-4444444444?token=SECRETVALUE#frag">conversation ${i}</a>`
  ).join("");

const unrelatedAnchors = (n) =>
  Array.from({ length: n }, (_, i) => `<a href="/docs/page-${i}">doc ${i}</a>`).join("");

const filler = (n) =>
  Array.from({ length: n }, (_, i) => `<div class="f${i}"><span>x</span></div>`).join("");

/** Mirrors the measured page: ~965 elements, no landmarks, div-only sidebar. */
const measuredPage = (sidebar) => `<!doctype html><html><body>
  <div class="wrap"><div class="col">${sidebar}</div></div>
  <div class="composer">${filler(900)}</div>
  <textarea id="msg"></textarea>
</body></html>`;

/**
 * Runs the REAL probe script in a REAL browser against a local fixture served at
 * the real origin, so `location.origin` and relative href resolution behave
 * exactly as they do on the live page.
 */
async function withFixturePage(run) {
  const { chromium } = requireFromProject("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let html = "";
  await context.route("https://chat.deepseek.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }));
  const page = await context.newPage();
  const script = authProbeScript({ answerSelectors: [".ds-markdown"] });
  const measure = async (body) => {
    html = measuredPage(body);
    await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded" });
    const observations = await page.evaluate(script);
    return { observations, state: classifyAuthState(observations) };
  };
  try {
    return await run(measure);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// 1-3, 9. The measured shape
// ---------------------------------------------------------------------------

test("V16.3 history composer + 15 visible /a/chat/s/ anchors is READY", async () => {
  await withFixturePage(async (measure) => {
    const { observations, state } = await measure(chatAnchors(15));
    assert.equal(observations.historyCount, 15);
    assert.equal(observations.composerVisible, true);
    assert.equal(state.state, "READY");
    assert.equal(state.reason, "composer-and-history-present");
  });
});

test("V16.3 history composer + 2 visible /a/chat/s/ anchors is READY", async () => {
  await withFixturePage(async (measure) => {
    const { observations, state } = await measure(chatAnchors(2));
    assert.equal(observations.historyCount, 2);
    assert.equal(state.state, "READY");
  });
});

test("V16.3 history composer + 1 visible /a/chat/s/ anchor stays UNKNOWN", async () => {
  await withFixturePage(async (measure) => {
    const { observations, state } = await measure(chatAnchors(1));
    assert.equal(observations.historyCount, 1);
    assert.equal(MIN_HISTORY_ROWS_FOR_SESSION, 2);
    assert.equal(state.state, "UNKNOWN");
    assert.equal(state.reason, "composer-visible-but-no-session-signal");
  });
});

test("V16.3 history the logged-out composer-only shell remains UNKNOWN", async () => {
  await withFixturePage(async (measure) => {
    const { observations, state } = await measure("");
    assert.equal(observations.historyCount, 0);
    assert.equal(observations.composerVisible, true);
    assert.equal(state.state, "UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 4-5. Visibility and specificity
// ---------------------------------------------------------------------------

test("V16.3 history hidden /a/chat/s/ anchors do not count", async () => {
  await withFixturePage(async (measure) => {
    const hidden = await measure(chatAnchors(15, { hidden: true }));
    assert.equal(hidden.observations.historyCount, 0);
    assert.equal(hidden.state.state, "UNKNOWN");
    // The same anchors VISIBLE do count, so the difference is visibility alone.
    const visible = await measure(chatAnchors(15));
    assert.equal(visible.observations.historyCount, 15);
    assert.equal(visible.state.state, "READY");
  });
});

test("V16.3 history unrelated anchors never count as conversations", async () => {
  await withFixturePage(async (measure) => {
    const { observations, state } = await measure(unrelatedAnchors(20));
    assert.equal(observations.historyCount, 0);
    assert.equal(state.state, "UNKNOWN");
  });
});

test("V16.3 history the chat path prefix is matched exactly, not fuzzily", async () => {
  await withFixturePage(async (measure) => {
    // A near-miss path that must not count.
    const near = `<a href="/a/chat/">x</a><a href="/a/chatty/">y</a><a href="/other/chat/s/z">z</a>`;
    const { observations } = await measure(near);
    assert.equal(observations.historyCount, 0);
    // And the exact prefix does.
    const exact = await measure(`<a href="${CHAT_PATH}abc">ok</a>`);
    assert.equal(exact.observations.historyCount, 1);
  });
});

test("V16.3 history the count is capped at 50", async () => {
  await withFixturePage(async (measure) => {
    const { observations } = await measure(chatAnchors(120));
    assert.equal(observations.historyCount, 50);
  });
});

// ---------------------------------------------------------------------------
// 7-8. Combination with the generic detector
// ---------------------------------------------------------------------------

test("V16.3 history generic structural detection still works", async () => {
  await withFixturePage(async (measure) => {
    // A conventional landmark sidebar with no chat-path hrefs.
    const { observations, state } = await measure(`<nav><ul>${unrelatedAnchors(5)}</ul></nav>`);
    assert.equal(observations.historyCount, 5);
    assert.equal(state.state, "READY");
  });
});

test("V16.3 history generic and chat-path detectors combine with MAX, never SUM", async () => {
  await withFixturePage(async (measure) => {
    // The SAME 6 rows are visible to both detectors: a nav containing the chat
    // anchors. Summing would report 12; max must report 6.
    const both = await measure(`<nav><div>${chatAnchors(6)}</div></nav>`);
    assert.equal(both.observations.historyCount, 6, "overlapping rows must not double-count");

    // Generic sees MORE than the path detector.
    const genericWins = await measure(`<nav><ul>${unrelatedAnchors(8)}</ul></nav>${chatAnchors(3)}`);
    assert.equal(genericWins.observations.historyCount, 8);

    // Path detector sees MORE than the generic detector.
    const pathWins = await measure(`<nav><div>${unrelatedAnchors(2)}</div></nav>${chatAnchors(7)}`);
    assert.equal(pathWins.observations.historyCount, 7);
  });
});

// ---------------------------------------------------------------------------
// 6, 11. Nothing sensitive crosses the worker boundary
// ---------------------------------------------------------------------------

test("V16.3 history no query, fragment, conversation id or title crosses the boundary", async () => {
  await withFixturePage(async (measure) => {
    const { observations } = await measure(chatAnchors(4));
    const serialized = JSON.stringify(observations);
    for (const forbidden of [
      "SECRETVALUE", "token=", "#frag", "6f1c", "1111-2222", "conversation 0",
      CHAT_PATH,
    ]) {
      assert.ok(!serialized.includes(forbidden), `observations leaked ${forbidden}`);
    }
    // Only the count survives.
    assert.equal(typeof observations.historyCount, "number");
  });
});

test("V16.3 history the worker payload carries only the count", () => {
  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true,
    requestId: "h1",
    operation: BROWSER_WORKER_OPERATION.AUTH_PROBE,
    payload: {
      auth: {
        url: "https://chat.deepseek.com/",
        composerVisible: true,
        accountSignal: false,
        answerRegions: 0,
        historyCount: 15,
        // A worker that wrongly emitted these must be dropped by the decoder.
        historyHrefs: ["/a/chat/s/6f1c-uuid"],
        conversationTitles: ["private thread"],
        accountName: "Ada Lovelace",
        cookie: "sid=abc",
      },
    },
  }));
  const auth = decoded.result.auth;
  assert.equal(auth.historyCount, 15);
  for (const key of ["historyHrefs", "conversationTitles", "accountName", "cookie"]) {
    assert.ok(!Object.hasOwn(auth, key), `decoder must not expose ${key}`);
  }
  const serialized = JSON.stringify(decoded);
  for (const forbidden of ["6f1c-uuid", "private thread", "Ada Lovelace", "sid=abc"]) {
    assert.ok(!serialized.includes(forbidden), `decoder leaked ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 10. The account path is unchanged
// ---------------------------------------------------------------------------

test("V16.3 history the accountSignal path is unchanged by this fix", () => {
  // Account affordance alone still admits READY, with no history at all.
  const accountOnly = classifyAuthState({
    url: "https://chat.deepseek.com/",
    composerVisible: true,
    accountSignal: true,
    answerRegions: 0,
    historyCount: 0,
  });
  assert.equal(accountOnly.state, "READY");
  assert.equal(accountOnly.reason, "composer-and-account-signal-present");

  // Assistant answers alone still admit READY.
  const answersOnly = classifyAuthState({
    url: "https://chat.deepseek.com/",
    composerVisible: true,
    accountSignal: false,
    answerRegions: 2,
    historyCount: 0,
  });
  assert.equal(answersOnly.state, "READY");
  assert.equal(answersOnly.reason, "composer-and-answer-region-present");

  // The login wall still outranks all of them.
  const wall = classifyAuthState({
    url: "https://chat.deepseek.com/login",
    composerVisible: true,
    accountSignal: true,
    answerRegions: 5,
    historyCount: 30,
  });
  assert.equal(wall.state, "NEEDS_AUTH");
});

test("V16.3 history composer alone is never sufficient, under any history value", () => {
  // Without history/account/answers the composer cannot carry the decision. The
  // only escape is history >= 2, which is a measured count, not the composer.
  for (const historyCount of [0, 1]) {
    const state = classifyAuthState({
      url: "https://chat.deepseek.com/",
      composerVisible: true,
      accountSignal: false,
      answerRegions: 0,
      historyCount,
    });
    assert.notEqual(state.state, "READY", `historyCount=${historyCount}`);
  }
});

// ---------------------------------------------------------------------------
// The READY rule is still the same shape
// ---------------------------------------------------------------------------

test("V16.3 history the READY rule is composer AND one positive session signal", () => {
  const script = authProbeScript({});
  // The path evaluation must live INSIDE the page.
  assert.ok(script.includes("/a/chat/s/"));
  assert.ok(script.includes("new URL("));
  assert.ok(script.includes(".pathname"));
  // MAX, not sum.
  assert.ok(script.includes("Math.max(genericHistoryCount, deepSeekChatPathCount)"));
  assert.ok(!script.includes("genericHistoryCount + deepSeekChatPathCount"));
  // The generic detector is retained.
  assert.ok(script.includes("SIDEBAR_CONTAINERS"));
});