// V16.3 DeepSeek locator repair: measured composer/send/answer resolution.
//
// REAL LIVE EVIDENCE (persistent profile, authenticated, READY):
//   auth settle: 2 probes, ~1157ms, historyCount 50
//   fill role=textbox name="message to DeepSeek": TIMEOUT (selector drift)
//   fill selector=textarea: SUCCESS
//   domInspect aggregates: textarea=1, contenteditable=0, buttons=5
//
// So the composer cascade must try the legacy semantic locator first and fall
// back to the measured structural locators. Nothing here is guessed: every
// fallback corresponds to a measured count on the real page.
//
// WHAT THIS MODULE MAY DO
//   - describe candidates by tag, role, GENERIC aria token, testid PRESENCE,
//     disabled state, composer-relative position and generic class tokens
//   - count visible matches per candidate family (numbers only)
// WHAT IT MUST NEVER DO
//   - read an input VALUE or textarea value
//   - read page text, conversation titles/snippets, account names
//   - read cookies/storage/tokens, raw SVG/path data, hrefs or ids
//   - click, type, submit or otherwise act (resolution is read-only)

export const DEEPSEEK_LOCATOR_KIND = Object.freeze({
  COMPOSER: "composer",
  SEND: "send",
  ANSWER: "answer",
})

export const DEEPSEEK_LOCATOR_STRATEGY = Object.freeze({
  ROLE_AND_NAME: "role-and-accessible-name",
  CSS: "bounded-css",
  SEMANTIC_SELECTOR: "stable-semantic-selector",
})

// Ordered composer cascade. Legacy semantic first (preferred when it
// resolves), measured structural fallbacks after. textarea is proven on the
// real page; contenteditable/text-input are the auth probe's own composer
// signals, kept as last resorts behind the uniqueness gate.
export const DEEPSEEK_COMPOSER_CANDIDATES = Object.freeze([
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME, role: "textbox", accessibleName: "message to DeepSeek" }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: "textarea" }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: '[contenteditable="true"]' }),
])

// Ordered send cascade. Legacy semantic first; measured structural fallbacks
// after (populated from composer-vicinity evidence, never coordinates).
export const DEEPSEEK_SEND_CANDIDATES = Object.freeze([
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME, role: "button", accessibleName: "Send" }),
  // Measured 2026-10-03 on the live page (visible-match counts, read-only):
  // the toolbar div adjacent to the textarea's parent holds exactly the two
  // composer controls. `.first()` (worker-side) selects the nearest one; the
  // post-click dispatch verification gates actual submission, so a mismatch
  // fails closed to UI_CHANGED without ever submitting.
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: 'div:has(> textarea) + div [role="button"]' }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: 'div:has(> textarea) ~ div [role="button"]' }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: 'textarea + div[role="button"]' }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.CSS, selector: 'div:has(> textarea) div[role="button"]' }),
])

// Ordered answer-region cascade. Primary is the long-standing selector;
// fallbacks mirror the auth probe's measured answer-selector family.
export const DEEPSEEK_ANSWER_CANDIDATES = Object.freeze([
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.SEMANTIC_SELECTOR, selector: "[data-message-role='assistant']" }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.SEMANTIC_SELECTOR, selector: "[data-role='assistant']" }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.SEMANTIC_SELECTOR, selector: ".ds-markdown" }),
  Object.freeze({ strategy: DEEPSEEK_LOCATOR_STRATEGY.SEMANTIC_SELECTOR, selector: "[class*='assistant']" }),
])

/**
 * Bounded read-only composer-vicinity diagnostic. Evaluated in the page.
 *
 * Returns COUNTS and SAFE DESCRIPTORS only: tag, role, generic aria token,
 * testid presence, disabled state, composer-relative position, generic class
 * tokens. Never values, text, hrefs, ids, or raw SVG data. Never acts.
 */
export function composerVicinityScript(options = {}) {
  const nearbyLimit = Math.max(1, Math.min(25, Number(options.nearbyLimit) || 10))
  const defaultAnswers = [...DEEPSEEK_ANSWER_CANDIDATES.map((c) => c.selector)]
  const answerSelectors = (Array.isArray(options.answerSelectors) && options.answerSelectors.length
    ? options.answerSelectors
    : defaultAnswers).slice(0, 8).map((s) => String(s).slice(0, 200))
  // Production send-candidate selectors, counted IN-PAGE (visible matches as
  // NUMBERS only). This proves exactly which composer-relative selector the
  // live page satisfies, instead of inferring it from archaeology.
  const defaultSend = [...DEEPSEEK_SEND_CANDIDATES.filter((c) => c.selector).map((c) => c.selector)]
  const sendSelectors = (Array.isArray(options.sendSelectors) && options.sendSelectors.length
    ? options.sendSelectors
    : defaultSend).slice(0, 8).map((s) => String(s).slice(0, 200))
  const labelVocab = ["send", "submit", "stop", "message", "chat", "new"]
  return `(() => {
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      try {
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      } catch { return false; }
    };
    const genericLabel = (el) => {
      const raw = String(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80).toLowerCase();
      if (!raw) return { present: false, generic: null };
      const vocab = ${JSON.stringify(labelVocab)};
      for (const allowed of vocab) {
        if (raw === allowed || raw.includes(allowed)) return { present: true, generic: allowed };
      }
      return { present: true, generic: null };
    };
    // Accessible-name sources for chrome controls (icon buttons often carry
    // their name in title/svg-title/content rather than aria-label). Evaluated
    // IN-PAGE and reduced to a GENERIC token immediately: only the token
    // crosses the boundary, never the raw label.
    const controlName = (el) => {
      const vocab = ${JSON.stringify(labelVocab)};
      const sources = [];
      try {
        sources.push(String(el.getAttribute("title") || ""));
        const svgTitle = el.querySelector("svg title");
        if (svgTitle) sources.push(String(svgTitle.textContent || ""));
        sources.push(String(el.textContent || ""));
      } catch {}
      const raw = sources.join(" ").replace(/\\s+/g, " ").trim().slice(0, 80).toLowerCase();
      if (!raw) return { present: false, generic: null };
      for (const allowed of vocab) {
        if (raw === allowed || raw.includes(allowed)) return { present: true, generic: allowed };
      }
      return { present: true, generic: null };
    };
    const safeButton = (el) => ({
      tag: String(el.tagName || "").toLowerCase().slice(0, 20),
      role: String(el.getAttribute("role") || "").toLowerCase().slice(0, 30) || null,
      ariaLabel: genericLabel(el),
      controlName: controlName(el),
      testId: el.getAttribute("data-testid") ? "[present]" : null,
      disabled: el.disabled === true || String(el.getAttribute("aria-disabled") || "").toLowerCase() === "true",
      type: String(el.getAttribute("type") || "").toLowerCase().slice(0, 20) || null,
      // Shape-only hints to tell adjacent composer controls apart. Numbers and
      // presence booleans; never coordinates used for targeting, never content.
      hasSvg: (() => { try { return el.querySelector("svg") !== null; } catch { return false; } })(),
      childCount: el.children ? el.children.length : 0,
      kinship: kinship(el),
      box: (() => {
        try {
          const rect = el.getBoundingClientRect();
          return { w: Math.max(0, Math.round(rect.width)), h: Math.max(0, Math.round(rect.height)) };
        } catch { return null; }
      })(),
      tabIndex: (() => {
        try {
          const raw = el.getAttribute("tabindex");
          if (raw === null) return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : "other";
        } catch { return null; }
      })(),
    });
    // Tags-only structural context around the composer anchor: ancestor chain
    // and sibling tags. No classes, ids, text or attributes — shape only.
    // Computed AFTER the anchor resolves (see below).
    const tagsOnly = (el) => String(el && el.tagName ? el.tagName.toLowerCase() : "?").slice(0, 20);
    // Lowest-common-ancestor depth between a button and the composer anchor,
    // as NUMBERS only (steps up from each side). 1/1 = same parent (siblings).
    // No chains, tags or ids cross the boundary — just the two depths.
    const kinship = (el) => {
      if (!anchor) return { lcaButton: null, lcaAnchor: null, after: null };
      try {
        const anchorChain = new Set();
        let p = anchor;
        while (p) { anchorChain.add(p); p = p.parentElement; }
        let q = el;
        let upButton = 0;
        while (q && !anchorChain.has(q)) { q = q.parentElement; upButton += 1; }
        if (!q) return { lcaButton: null, lcaAnchor: null, after: null };
        let upAnchor = 0;
        let r = anchor;
        while (r !== q) { r = r.parentElement; upAnchor += 1; }
        const pos = anchor.compareDocumentPosition
          ? anchor.compareDocumentPosition(el)
          : 0;
        return {
          lcaButton: upButton,
          lcaAnchor: upAnchor,
          // DOCUMENT_POSITION_FOLLOWING === 4
          after: (pos & 4) !== 0 ? true : (pos & 2) !== 0 ? false : null,
        };
      } catch { return { lcaButton: null, lcaAnchor: null, after: null }; }
    };
    const composerSelectors = ["textarea", "[contenteditable=\\"true\\"]", "input[type=\\"text\\"]"];
    const composers = [];
    for (const selector of composerSelectors) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)).filter(visible); } catch { nodes = []; }
      composers.push({
        selector,
        visible: nodes.length,
        rows: nodes.slice(0, 4).map((el, index) => ({
          index,
          tag: String(el.tagName || "").toLowerCase().slice(0, 20),
          ariaLabel: genericLabel(el),
          testId: el.getAttribute("data-testid") ? "[present]" : null,
          disabled: el.disabled === true,
          hasNameAttr: Boolean(el.getAttribute("name")),
        })),
      });
    }
    // Buttons near the FIRST visible composer family in DOM order.
    let anchor = null;
    for (const selector of composerSelectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
        if (nodes.length) { anchor = nodes[0]; break; }
      } catch {}
    }
    const allButtons = (() => {
      try { return Array.from(document.querySelectorAll("button, [role=\\"button\\"]")).filter(visible); } catch { return []; }
    })();
    let nearby = [];
    if (anchor) {
      const order = (() => {
        try { return Array.from(document.querySelectorAll("textarea, [contenteditable], button, [role=\\"button\\"], input")); } catch { return []; }
      })();
      const anchorPos = order.indexOf(anchor);
      nearby = allButtons
        .map((el) => ({ el, pos: order.indexOf(el) }))
        .filter((row) => row.pos !== -1 && anchorPos !== -1)
        .map((row) => ({ ...row, distance: Math.abs(row.pos - anchorPos), after: row.pos > anchorPos }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, ${nearbyLimit})
        .map((row) => ({ ...safeButton(row.el), distance: row.distance, afterComposer: row.after }));
    } else {
      nearby = allButtons.slice(0, ${nearbyLimit}).map((el) => ({ ...safeButton(el), distance: null, afterComposer: null }));
    }
    const answerCounts = {};
    for (const selector of ${JSON.stringify(answerSelectors)}) {
      try { answerCounts[selector] = Array.from(document.querySelectorAll(selector)).filter(visible).length; }
      catch { answerCounts[selector] = 0; }
    }
    const sendMatches = {};
    for (const selector of ${JSON.stringify(sendSelectors)}) {
      try { sendMatches[selector] = Array.from(document.querySelectorAll(selector)).filter(visible).length; }
      catch { sendMatches[selector] = 0; }
    }
    // Tags-only context AFTER the anchor resolved (TDZ-safe: anchor exists).
    const composerContext = (() => {
      if (!anchor) return null;
      const ancestors = [];
      let p = anchor.parentElement;
      for (let depth = 0; depth < 4 && p; depth += 1) {
        ancestors.push(tagsOnly(p));
        p = p.parentElement;
      }
      const parent = anchor.parentElement;
      const siblings = [];
      if (parent && parent.children) {
        for (const child of Array.from(parent.children).slice(0, 12)) {
          siblings.push({ tag: tagsOnly(child), role: String(child.getAttribute ? (child.getAttribute("role") || "") : "").toLowerCase().slice(0, 30) || null, isAnchor: child === anchor });
        }
      }
      return { ancestors, siblings };
    })();
    return {
      url: String(location.href || "").split("?")[0].split("#")[0].slice(0, 120),
      composers,
      composerContext,
      sendNearby: nearby,
      sendTotal: allButtons.length,
      sendMatches,
      answers: answerCounts,
    };
  })()`;
}

/**
 * Server-side re-filter for vicinity output. Second independent boundary:
 * anything not on the allowlist is dropped here regardless of what the page
 * script claimed.
 */
export function sanitizeComposerVicinity(input = /** @type {any} */ ({})) {
  const raw = /** @type {any} */ (input && typeof input === "object" ? input : {})
  const labelAllow = new Set(["send", "submit", "stop", "message", "chat", "new"])
  const safeLabel = (label) => {
    if (!label || typeof label !== "object") return { present: false, generic: null }
    const generic = typeof label.generic === "string" && labelAllow.has(label.generic) ? label.generic : null
    return { present: label.present === true, generic }
  }
  const safeRow = (row) => ({
    index: Math.max(0, Number(row?.index) || 0),
    tag: String(row?.tag || "").slice(0, 20),
    ariaLabel: safeLabel(row?.ariaLabel),
    testId: row?.testId === "[present]" ? "[present]" : null,
    disabled: row?.disabled === true,
    hasNameAttr: row?.hasNameAttr === true,
  })
  const safeButton = (row) => ({
    ...safeRow(row),
    role: row?.role ? String(row.role).slice(0, 30) : null,
    type: row?.type ? String(row.type).slice(0, 20) : null,
    controlName: safeLabel(row?.controlName),
    hasSvg: row?.hasSvg === true,
    childCount: Math.max(0, Number(row?.childCount) || 0),
    box: row?.box && typeof row.box === "object"
      ? { w: Math.max(0, Number(row.box.w) || 0), h: Math.max(0, Number(row.box.h) || 0) }
      : null,
    kinship: row?.kinship && typeof row.kinship === "object"
      ? {
        lcaButton: row.kinship.lcaButton === null || row.kinship.lcaButton === undefined ? null : Math.max(0, Number(row.kinship.lcaButton) || 0),
        lcaAnchor: row.kinship.lcaAnchor === null || row.kinship.lcaAnchor === undefined ? null : Math.max(0, Number(row.kinship.lcaAnchor) || 0),
        after: row.kinship.after === true ? true : row.kinship.after === false ? false : null,
      }
      : { lcaButton: null, lcaAnchor: null, after: null },
    tabIndex: row?.tabIndex === null || row?.tabIndex === undefined
      ? null
      : (typeof row.tabIndex === "number" ? row.tabIndex : String(row.tabIndex).slice(0, 10)),
    distance: row?.distance === null || row?.distance === undefined ? null : Math.max(0, Number(row.distance) || 0),
    afterComposer: row?.afterComposer === true ? true : row?.afterComposer === false ? false : null,
  })
  const safeContext = (context) => {
    if (!context || typeof context !== "object") return null
    const tag = (value) => String(value || "?").slice(0, 20)
    return {
      ancestors: (Array.isArray(context.ancestors) ? context.ancestors : []).slice(0, 4).map(tag),
      siblings: (Array.isArray(context.siblings) ? context.siblings : []).slice(0, 12).map((sib) => ({
        tag: tag(sib?.tag),
        role: sib?.role ? String(sib.role).slice(0, 30) : null,
        isAnchor: sib?.isAnchor === true,
      })),
    }
  }
  const composers = Array.isArray(raw.composers) ? raw.composers.slice(0, 4) : []
  const answers = raw.answers && typeof raw.answers === "object" ? raw.answers : {}
  const safeAnswers = {}
  for (const [key, value] of Object.entries(answers).slice(0, 8)) {
    safeAnswers[String(key).slice(0, 200)] = Math.max(0, Number(value) || 0)
  }
  const sendMatches = raw.sendMatches && typeof raw.sendMatches === "object" ? raw.sendMatches : {}
  const safeSendMatches = {}
  for (const [key, value] of Object.entries(sendMatches).slice(0, 8)) {
    safeSendMatches[String(key).slice(0, 200)] = Math.max(0, Number(value) || 0)
  }
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-composer-vicinity",
    url: String(raw.url || "").split("?")[0].split("#")[0].slice(0, 120),
    composers: composers.map((family) => ({
      selector: String(family?.selector || "").slice(0, 80),
      visible: Math.max(0, Number(family?.visible) || 0),
      rows: (Array.isArray(family?.rows) ? family.rows : []).slice(0, 4).map(safeRow),
    })),
    composerContext: safeContext(raw.composerContext),
    sendNearby: (Array.isArray(raw.sendNearby) ? raw.sendNearby : []).slice(0, 25).map(safeButton),
    sendTotal: Math.max(0, Number(raw.sendTotal) || 0),
    sendMatches: safeSendMatches,
    answers: safeAnswers,
    disclosure: {
      pageTextRead: false,
      inputValuesRead: false,
      cookiesRead: false,
      storageRead: false,
      conversationTitlesRead: false,
      accountNameRead: false,
      acted: false,
    },
  }
}

/**
 * Resolve one DeepSeek target from a SANITIZED vicinity inspection.
 *
 * Pure function over safe counts/descriptors. Returns
 * `{ ok, strategy, target, candidates, reason }`. Never returns private text.
 * Fail-closed: ambiguity or absence is UI_CHANGED, never a guess.
 *
 * @param {string} kind "composer" | "send" | "answer"
 * @param {Record<string, any>} inspection sanitized vicinity (or domInspect aggregates)
 * @param {Record<string, any>} options { snapshot } optional raw-snapshot rows for legacy preference
 */
export function resolveDeepSeekTarget(kind = "", inspection = /** @type {any} */ ({}), options = /** @type {any} */ ({})) {
  const want = String(kind || "").trim().toLowerCase()
  const rows = Array.isArray(options.snapshot) ? options.snapshot : null

  if (want === DEEPSEEK_LOCATOR_KIND.COMPOSER) {
    // 1. Legacy semantic locator wins when a snapshot proves a matching
    //    visible textbox exists (deterministic tests + any lane that can
    //    observe accessible names without crossing a privacy boundary).
    if (rows) {
      const legacy = rows.filter((row) =>
        row && row.visible !== false &&
        String(row.role || "").toLowerCase() === "textbox" &&
        String(row.accessibleName || row.name || "").toLowerCase().includes("message to deepseek"));
      if (legacy.length === 1) {
        return {
          ok: true, kind: want, strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME,
          target: { ...DEEPSEEK_COMPOSER_CANDIDATES[0] },
          candidates: DEEPSEEK_COMPOSER_CANDIDATES.length,
          reason: "legacy-composer-resolves",
        }
      }
    }
    // 2. Measured structural cascade over safe counts. Exactly one visible
    //    match is required; ambiguity fails closed.
    const families = Array.isArray(inspection?.composers) ? inspection.composers : null
    const countFor = (selector) => {
      if (families) {
        const family = families.find((f) => String(f?.selector) === selector)
        if (family) return Math.max(0, Number(family.visible) || 0)
      }
      const agg = inspection?.aggregates || {}
      if (selector === "textarea") return Math.max(0, Number(agg.textarea) || 0)
      if (selector === '[contenteditable="true"]') return Math.max(0, Number(agg.contenteditable) || 0)
      return 0
    }
    for (const candidate of DEEPSEEK_COMPOSER_CANDIDATES.slice(1)) {
      const n = countFor(candidate.selector)
      if (n === 1) {
        return {
          ok: true, kind: want, strategy: candidate.strategy,
          target: { ...candidate },
          candidates: DEEPSEEK_COMPOSER_CANDIDATES.length,
          reason: `structural-composer-resolves:${candidate.selector}`,
        }
      }
      if (n > 1) {
        return {
          ok: false, kind: want, strategy: null, target: null,
          candidates: DEEPSEEK_COMPOSER_CANDIDATES.length,
          reason: `ambiguous-composer:${candidate.selector}-matches-${n}`,
        }
      }
    }
    return {
      ok: false, kind: want, strategy: null, target: null,
      candidates: DEEPSEEK_COMPOSER_CANDIDATES.length,
      reason: "no-usable-composer",
    }
  }

  if (want === DEEPSEEK_LOCATOR_KIND.SEND) {
    const nearby = Array.isArray(inspection?.sendNearby) ? inspection.sendNearby : null
    const matches = inspection?.sendMatches && typeof inspection.sendMatches === "object" ? inspection.sendMatches : null
    // Generic send label from any safe source (aria-label or control name).
    const genericOf = (row) => row?.ariaLabel?.generic || row?.controlName?.generic || null
    // 1. Legacy semantic locator wins when a snapshot proves a matching
    //    visible Send button exists.
    if (rows) {
      const legacy = rows.filter((row) =>
        row && row.visible !== false &&
        String(row.role || "").toLowerCase() === "button" &&
        String(row.accessibleName || row.name || "").toLowerCase().includes("send"));
      if (legacy.length === 1) {
        return {
          ok: true, kind: want, strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME,
          target: { ...DEEPSEEK_SEND_CANDIDATES[0] },
          candidates: nearby ? nearby.length : DEEPSEEK_SEND_CANDIDATES.length,
          reason: "legacy-send-resolves",
        }
      }
    }
    if (nearby) {
      // 2. An enabled nearby control with a generic send label.
      const semantic = nearby.filter((row) =>
        row && row.disabled !== true && genericOf(row) === "send");
      if (semantic.length >= 1) {
        return {
          ok: true, kind: want, strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME,
          target: { ...DEEPSEEK_SEND_CANDIDATES[0] },
          candidates: nearby.length,
          reason: "measured-send-resolves:send",
        }
      }
      // 3. Measured composer-relative selectors, in cascade order: the live
      //    page proved which of these match via visible-match counts.
      if (matches) {
        for (const candidate of DEEPSEEK_SEND_CANDIDATES.slice(1)) {
          const n = Math.max(0, Number(matches[candidate.selector]) || 0)
          if (n > 0) {
            return {
              ok: true, kind: want, strategy: candidate.strategy,
              target: { ...candidate },
              candidates: nearby.length,
              reason: `measured-send-resolves:${candidate.selector}-count-${n}`,
            }
          }
        }
      }
      return {
        ok: false, kind: want, strategy: null, target: null, candidates: nearby.length,
        reason: "no-usable-send-near-composer",
      }
    }
    // Without vicinity evidence the legacy locator is the only safe choice;
    // the caller attempts it and fails UI_CHANGED when it does not resolve.
    return {
      ok: true, kind: want, strategy: DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME,
      target: { ...DEEPSEEK_SEND_CANDIDATES[0] },
      candidates: DEEPSEEK_SEND_CANDIDATES.length,
      reason: "legacy-send-assumed",
    }
  }

  if (want === DEEPSEEK_LOCATOR_KIND.ANSWER) {
    const counts = inspection?.answers && typeof inspection.answers === "object" ? inspection.answers : null
    if (counts) {
      for (const candidate of DEEPSEEK_ANSWER_CANDIDATES) {
        const n = Math.max(0, Number(counts[candidate.selector]) || 0)
        if (n > 0) {
          return {
            ok: true, kind: want, strategy: candidate.strategy,
            target: { ...candidate },
            candidates: DEEPSEEK_ANSWER_CANDIDATES.length,
            reason: `measured-answer-resolves:${candidate.selector}-count-${n}`,
          }
        }
      }
      return {
        ok: false, kind: want, strategy: null, target: null,
        candidates: DEEPSEEK_ANSWER_CANDIDATES.length,
        reason: "no-answer-region-observed",
      }
    }
    return {
      ok: true, kind: want, strategy: DEEPSEEK_LOCATOR_STRATEGY.SEMANTIC_SELECTOR,
      target: { ...DEEPSEEK_ANSWER_CANDIDATES[0] },
      candidates: DEEPSEEK_ANSWER_CANDIDATES.length,
      reason: "primary-answer-assumed",
    }
  }

  return {
    ok: false, kind: String(kind || ""), strategy: null, target: null, candidates: 0,
    reason: "unknown-locator-kind",
  }
}
