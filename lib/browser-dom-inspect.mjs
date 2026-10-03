// V16.3 LIVE DeepSeek: read-only DOM diagnostics for selector repair.
//
// The real failure this exists for: the user was visibly logged in -- sidebar
// history, account UI, composer, chat surface -- and the auth detector reported
// no session signal for 89 consecutive probes. Guessing selectors would be
// guessing. So the repair path is: MEASURE the DOM, then derive the selectors.
//
// WHAT THIS MODULE MAY DO
//   - read structural attributes (tag, role, aria-label, data-testid, name, type)
//   - report shape of href PATHS (digits masked, query/fragment dropped)
//   - report class TOKENS that appear in a generic UI vocabulary
//   - report visibility, child count, and nav/aside/sidebar containment
//   - report aggregate counts per element family
//
// WHAT IT MUST NEVER DO
//   - read an input's VALUE, or a textarea's value
//   - read cookies, localStorage, sessionStorage, tokens, headers
//   - read innerText / textContent / conversation titles / snippets
//   - read an account name, display name, email or avatar URL
//   - click, type, submit or otherwise act
//
// The filtering is done INSIDE the page, so a sensitive attribute never even
// crosses the worker boundary. The decoder re-filters afterwards as a second,
// independent line of defence.

/**
 * Generic UI vocabulary. Only tokens in this set are ever returned verbatim.
 * Anything else becomes the literal `[filtered]`, which is enough to tell
 * "there is a class here" from "there is no class here" without disclosing
 * user-derived or account-derived names.
 */
export const GENERIC_UI_TOKENS = Object.freeze([
  "app", "aside", "avatar", "block", "btn", "button", "chat", "chatgpt", "child",
  "column", "container", "content", "conversation", "conversationlist", "dialog",
  "drawer", "dropdown", "editor", "element", "flex", "footer", "grid", "group",
  "header", "hidden", "history", "historylist", "icon", "input", "item", "label",
  "layout", "link", "list", "listbox", "listitem", "main", "markdown", "menu",
  "menuitem", "message", "messages", "modal", "nav", "navbar", "option", "panel",
  "placeholder", "popover", "primary", "row", "rows", "scroll", "secondary",
  "section", "send", "session", "sidebar", "sidebarwrap", "sticky", "submit",
  "tab", "textarea", "thread", "threads", "toolbar", "user", "wrapper",
]);

/**
 * aria-label / name / title vocabulary. A label outside this set is reported as
 * `hasAriaLabel: true` with the literal withheld, which is enough to know an
 * accessible name EXISTS without printing what it says.
 */
export const GENERIC_LABEL_TOKENS = Object.freeze([
  "account", "avatar", "back", "chat", "close", "conversation", "copy", "edit",
  "expand", "history", "menu", "message", "more", "new", "open", "panel",
  "profile", "refresh", "search", "send", "settings", "share", "sidebar",
  "sign out", "signin", "stop", "submit", "toggle", "user",
]);

function vocabSource() {
  return JSON.stringify({
    classTokens: [...GENERIC_UI_TOKENS],
    labelTokens: [...GENERIC_LABEL_TOKENS],
  });
}

/**
 * The bounded, read-only inspection script. Evaluated in the page.
 *
 * `options.limit` caps the number of ELEMENT ROWS returned. Aggregate counts are
 * always computed over a separate bounded scan so a busy page cannot make the
 * inspector itself expensive.
 */
export function domInspectScript(options = {}) {
  const limit = Math.max(1, Math.min(120, Number(options.limit) || 60));
  const vocab = vocabSource();
  return `(() => {
    const VOCAB = ${vocab};
    const classAllow = new Set(VOCAB.classTokens);
    const labelAllow = new Set(VOCAB.labelTokens);

    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };

    // Generic-or-filtered. Never returns a raw user-derived string.
    const safeClassTokens = (el) => {
      const raw = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ""));
      const tokens = raw.split(/\\s+/).filter(Boolean).slice(0, 8);
      const out = [];
      let filtered = 0;
      for (const token of tokens) {
        const lower = token.toLowerCase();
        if (classAllow.has(lower)) out.push(lower);
        else { filtered += 1; out.push("[filtered]"); }
      }
      return { tokens: out, filtered };
    };

    // An accessible name is reported as a GENERIC token or withheld entirely.
    const safeLabel = (el, attr) => {
      const raw = String(el.getAttribute(attr) || "").trim().slice(0, 80).toLowerCase();
      if (!raw) return { present: false, generic: null };
      for (const allowed of labelAllow) {
        if (raw === allowed || raw.includes(allowed)) return { present: true, generic: allowed };
      }
      return { present: true, generic: null };
    };

    // PAGE SHAPE ONLY: digits masked, query and fragment dropped. A real href
    // can carry a session token in its query, so the query never leaves here.
    const safeHref = (el) => {
      const href = String(el.getAttribute("href") || "");
      if (!href) return null;
      const path = href.split("?")[0].split("#")[0];
      const shape = path.replace(/[0-9a-fA-F]{4,}/g, "#").replace(/\\d+/g, "#").slice(0, 60);
      const hasQuery = href.includes("?");
      return { shape, hasQuery, hasFragment: href.includes("#") };
    };

    const inSidebar = (el) => {
      // Must be \`let\`: the ancestor walk reassigns it.
      let p = el.parentElement;
      let depth = 0;
      while (p && depth < 6) {
        const tag = p.tagName.toLowerCase();
        const role = String(p.getAttribute("role") || "").toLowerCase();
        if (tag === "nav" || tag === "aside" || role === "navigation" || role === "complementary") return true;
        const cls = String(typeof p.className === "string" ? p.className : "").toLowerCase();
        if (/sidebar|side-bar|nav-|navigation/.test(cls)) return true;
        p = p.parentElement;
        depth += 1;
      }
      return false;
    };

    const CANDIDATE_SELECTOR = [
      "button", "a[href]", "nav", "aside", "textarea", "[contenteditable]",
      "[role]", "[data-testid]", "[aria-label]", "[aria-haspopup]", "input",
      "li", "ul", "ol", "img", "svg", "[tabindex]",
    ].join(",");

    const rows = [];
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR)); } catch { nodes = []; }
    for (const el of nodes) {
      if (rows.length >= ${limit}) break;
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const cls = safeClassTokens(el);
      const aria = safeLabel(el, "aria-label");
      const title = safeLabel(el, "title");
      rows.push({
        tag,
        role: String(el.getAttribute("role") || "").toLowerCase() || null,
        ariaLabel: aria,
        title,
        testId: el.getAttribute("data-testid") ? "[present]" : null,
        hasNameAttr: Boolean(el.getAttribute("name")),
        type: String(el.getAttribute("type") || "").toLowerCase() || null,
        ariaHaspopup: el.getAttribute("aria-haspopup") ? String(el.getAttribute("aria-haspopup")).slice(0, 20) : null,
        contentEditable: el.getAttribute("contenteditable") ? String(el.getAttribute("contenteditable")).slice(0, 20) : null,
        href: safeHref(el),
        classTokens: cls.tokens,
        classFiltered: cls.filtered,
        inSidebar: inSidebar(el),
        childCount: el.children ? el.children.length : 0,
        visible: true,
      });
    }

    const count = (selector) => {
      try { return Array.from(document.querySelectorAll(selector)).filter(visible).length; } catch { return 0; }
    };
    const sidebarSelector = "nav a[href], aside a[href], [class*='sidebar' i] a[href]";
    const aggregates = {
      textarea: count("textarea"),
      contenteditable: count("[contenteditable]"),
      buttons: count("button, [role='button']"),
      nav: count("nav, [role='navigation']"),
      aside: count("aside, [role='complementary']"),
      roleList: count("[role='list'], ul, ol"),
      roleListItem: count("[role='listitem'], li"),
      sidebarLinks: count(sidebarSelector),
      totalCandidates: nodes.filter(visible).length,
      totalElements: document.querySelectorAll("*").length,
    };

    // Family counts for candidate account / history structures, as NUMBERS.
    const accountCandidates = [
      "[data-testid*='avatar' i]", "[data-testid*='account' i]", "[data-testid*='profile' i]",
      "[class*='avatar' i]", "[class*='account' i]", "[class*='profile' i]",
      "[class*='user' i]", "[aria-label*='profile' i]", "[aria-label*='account' i]",
      "[aria-label*='sign out' i]", "[aria-label*='log out' i]", "[title*='account' i]",
      "[title*='profile' i]", "[href*='/account' i]", "[href*='/profile' i]",
      "button[aria-haspopup='menu']", "[role='menuitem']",
    ];
    const historyCandidates = [
      "[data-testid*='conversation' i]", "[class*='conversation' i]",
      "[class*='chat-history' i]", "[class*='chatHistory' i]", "[class*='history' i]",
      "nav a[href*='/chat/']", "aside a[href]", "nav a[href]", "aside a", "[role='listitem']",
    ];
    const familyCount = (selectors) => {
      let total = 0;
      for (const selector of selectors) {
        try { total += Array.from(document.querySelectorAll(selector)).filter(visible).length; } catch {}
      }
      return total;
    };
    aggregates.accountCandidates = familyCount(accountCandidates);
    aggregates.historyCandidates = familyCount(historyCandidates);
    aggregates.roleMenuitem = count("[role='menuitem']");

    return {
      url: String(location.href || "").split("?")[0].split("#")[0],
      aggregates,
      rows,
      // A structural digest only: shape of the page, never its content.
      digest: String(document.body ? document.body.children.length : 0),
    };
  })()`;
}

/**
 * Server-side re-filter. The in-page script already withholds sensitive values,
 * but the decoder is a second independent boundary: anything not on the allowlist
 * is replaced here regardless of what a worker claimed.
 */
export function sanitizeDomInspection(input = /** @type {any} */ ({})) {
  const raw = /** @type {any} */ (input && typeof input === "object" ? input : {});
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const aggregates = raw.aggregates && typeof raw.aggregates === "object" ? raw.aggregates : {};

  const safeTokens = (tokens) => (Array.isArray(tokens) ? tokens : [])
    .slice(0, 8)
    .map((token) => (GENERIC_UI_TOKENS.includes(String(token).toLowerCase()) ? String(token).toLowerCase() : "[filtered]"));

  const safeShape = (href) => {
    if (!href || typeof href !== "object") return null;
    return {
      shape: String(href.shape || "").slice(0, 60),
      hasQuery: href.hasQuery === true,
      hasFragment: href.hasFragment === true,
    };
  };

  const safeLabel = (label) => {
    if (!label || typeof label !== "object") return null;
    const generic = label.generic === null || label.generic === undefined
      ? null
      : (GENERIC_LABEL_TOKENS.includes(String(label.generic)) ? String(label.generic) : null);
    return { present: label.present === true, generic };
  };

  return {
    schemaVersion: 1,
    kind: "ues-browser-dom-inspection",
    url: String(raw.url || "").split("?")[0].split("#")[0].slice(0, 200),
    aggregates: {
      textarea: Number(aggregates.textarea || 0),
      contenteditable: Number(aggregates.contenteditable || 0),
      buttons: Number(aggregates.buttons || 0),
      nav: Number(aggregates.nav || 0),
      aside: Number(aggregates.aside || 0),
      roleList: Number(aggregates.roleList || 0),
      roleListItem: Number(aggregates.roleListItem || 0),
      sidebarLinks: Number(aggregates.sidebarLinks || 0),
      roleMenuitem: Number(aggregates.roleMenuitem || 0),
      accountCandidates: Number(aggregates.accountCandidates || 0),
      historyCandidates: Number(aggregates.historyCandidates || 0),
      totalCandidates: Number(aggregates.totalCandidates || 0),
      totalElements: Number(aggregates.totalElements || 0),
    },
    rows: rows.slice(0, 120).map((row) => ({
      tag: String(row?.tag || "").slice(0, 20),
      role: row?.role ? String(row.role).slice(0, 30) : null,
      ariaLabel: safeLabel(row?.ariaLabel),
      title: safeLabel(row?.title),
      testId: row?.testId === "[present]" ? "[present]" : null,
      hasNameAttr: row?.hasNameAttr === true,
      type: row?.type ? String(row.type).slice(0, 30) : null,
      ariaHaspopup: row?.ariaHaspopup ? String(row.ariaHaspopup).slice(0, 20) : null,
      contentEditable: row?.contentEditable ? String(row.contentEditable).slice(0, 20) : null,
      href: safeShape(row?.href),
      classTokens: safeTokens(row?.classTokens),
      classFiltered: Number(row?.classFiltered || 0),
      inSidebar: row?.inSidebar === true,
      childCount: Number(row?.childCount || 0),
      visible: row?.visible === true,
    })),
    // Stated so a reader knows the boundary, not inferred from its absence.
    disclosure: {
      pageTextRead: false,
      inputValuesRead: false,
      cookiesRead: false,
      storageRead: false,
      conversationTitlesRead: false,
      accountNameRead: false,
      acted: false,
    },
  };
}

/**
 * Compact, safe auth summary: booleans and counts only. This is what makes
 * future selector drift diagnosable without exposing user data.
 */
export function authDebugSummary(observations = /** @type {any} */ ({}), probe = /** @type {any} */ ({})) {
  return {
    composerVisible: observations.composerVisible === true,
    accountSignal: observations.accountSignal === true,
    historyCount: Number(observations.historyCount || 0),
    answerRegions: Number(observations.answerRegions || 0),
    loginEvidence: observations.loginEvidence === true,
    urlPath: String(observations.url || "").split("?")[0].split("#")[0].slice(0, 120),
    classifiedState: String(probe.state || "UNKNOWN"),
    reason: String(probe.reason || "").slice(0, 120),
    disclosure: "booleans and counts only; no page content, no account text, no credentials",
  };
}