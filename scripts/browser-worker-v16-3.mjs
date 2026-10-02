#!/usr/bin/env node

// V16.3 managed browser worker.
//
// A deliberately SMALL process. It reads newline-delimited JSON requests on
// stdin, executes ONE protocol operation, and writes one JSON response per line.
// It has no filesystem-write authority beyond its own screenshot directory, no
// shell, and no network calls of its own -- page content arrives over the browser,
// and everything it returns is untrusted external data.
//
// If Playwright is not installed the worker does NOT pretend. It answers
// `capability` with `state: unavailable` and every other operation with
// `browser-worker-unavailable`, which is what makes the controller's fallback
// posture observable instead of silent.
//
//   node scripts/browser-worker-v16-3.mjs           # stdio protocol
//   node scripts/browser-worker-v16-3.mjs --probe    # print capability and exit

import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  BROWSER_WORKER_FAILURE,
  BROWSER_WORKER_OPERATION,
  BROWSER_WORKER_PROTOCOL_VERSION,
  classifyWorkerOperation,
  decodeWorkerResponse,
  encodeWorkerRequest,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function safeUrl(value) {
  const raw = String(value ?? "").trim()
  if (!raw) throw new Error("browser-worker requires an http(s) URL")
  const parsed = new URL(raw)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("browser-worker only allows http(s) URLs")
  }
  return parsed.toString()
}

function loadPlaywright() {
  const requireFromProject = createRequire(path.join(root, "package.json"))
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      const mod = requireFromProject(name)
      if (mod?.chromium) return mod
      if (mod?.default?.chromium) return mod.default
    } catch {}
  }
  return null
}

function roleForElement(el) {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute("type") || "").toLowerCase()
  if (tag === "button") return "button"
  if (tag === "a" && el.hasAttribute("href")) return "link"
  if (/^h[1-6]$/.test(tag)) return "heading"
  if (tag === "input") {
    if (["button", "submit", "reset"].includes(type)) return "button"
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    return "textbox"
  }
  if (tag === "textarea") return "textbox"
  if (tag === "select") return "combobox"
  return tag
}

async function main() {
  const playwright = loadPlaywright()
  let browser = null
  let page = null
  const consoleErrors = []
  const networkFailures = []
  let lastUrl = null

  async function ensurePage() {
    if (page) return page
    if (!playwright) {
      const error = new Error("Playwright is not installed in this project; add playwright or @playwright/test")
      error.code = BROWSER_WORKER_FAILURE.UNAVAILABLE
      throw error
    }
    browser = await playwright.chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on("console", (message) => {
      if (["error", "warning"].includes(String(message.type() || ""))) {
        consoleErrors.push(String(message.text() || "").slice(0, 400))
      }
    })
    page.on("requestfailed", (request) => {
      networkFailures.push(String(request.url?.() || "").slice(0, 400))
    })
    return page
  }

  async function resolveTarget(target = {}) {
    if (target.role && target.name) return page.getByRole(target.role, { name: target.name }).first()
    if (target.selector) return page.locator(target.selector).first()
    throw new Error("browser-worker needs a role+name or selector target")
  }

  async function snapshotElements(maxElements) {
    return page.evaluate((limit) => {
      const clean = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
      const selector = [
        "button", "a[href]", "input", "textarea", "select",
        "h1", "h2", "h3", "[role]", "[data-testid]",
      ].join(",")
      let nodes = []
      try { nodes = Array.from(document.querySelectorAll(selector)) } catch { nodes = [] }
      return nodes.slice(0, limit).map((el, index) => {
        const rect = el.getBoundingClientRect()
        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || roleForElement(el),
          name: clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent),
          text: clean(el.textContent),
          id: el.id || null,
          testId: el.getAttribute("data-testid") || null,
          visible: Boolean(rect.width > 0 && rect.height > 0),
        }
      })
    }, maxElements)
  }

  // One request in, one observation set out. `ok` means "the browser performed
  // the operation", never "the intended outcome is proven".
  async function handle(request) {
    const encoded = encodeWorkerRequest(request)
    if (!encoded.ok) {
      return encodeWorkerResponse({
        ok: false,
        requestId: String(request?.requestId || ""),
        operation: String(request?.operation || ""),
        failure: encoded.failure,
      })
    }
    const { operation, payload } = encoded

    if (operation === BROWSER_WORKER_OPERATION.CAPABILITY) {
      return encodeWorkerResponse({
        ok: true,
        requestId: payload.requestId,
        operation,
        payload: {
          protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
          playwright: playwright ? "available" : "unavailable",
          browserState: playwright ? "ready" : "unavailable",
          interactive: Boolean(playwright),
          inspectOnly: Boolean(playwright),
        },
      })
    }

    try {
      const activePage = await ensurePage()
      const beforeUrl = activePage.url() || lastUrl
      const timeout = boundedInt(payload.timeoutMs, 30_000, 500, 180_000)
      const base = { beforeUrl, url: activePage.url(), filledChars: 0, inputCleared: false, elements: [], consoleErrors, networkFailures }

      if (operation === BROWSER_WORKER_OPERATION.NAVIGATE) {
        const response = await activePage.goto(safeUrl(payload.url), { waitUntil: payload.waitUntil, timeout })
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: {
            ...base,
            finalUrl: activePage.url(),
            redirected: Boolean(response?.redirected?.().length),
            loadState: "load",
            documentChanged: true,
            snapshotRef: `snap-${Date.now().toString(36)}`,
          },
        })
      }
      if ([BROWSER_WORKER_OPERATION.RELOAD, BROWSER_WORKER_OPERATION.BACK, BROWSER_WORKER_OPERATION.FORWARD].includes(operation)) {
        if (operation === BROWSER_WORKER_OPERATION.RELOAD) await activePage.reload({ timeout })
        else if (operation === BROWSER_WORKER_OPERATION.BACK) await activePage.goBack({ timeout })
        else await activePage.goForward({ timeout })
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: { ...base, finalUrl: activePage.url(), documentChanged: true, loadState: "load" },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.SNAPSHOT) {
        const elements = await snapshotElements(80)
        const bodyText = await activePage.evaluate(() => String(document.body?.innerText || "").slice(0, 40_000))
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: {
            ...base,
            finalUrl: activePage.url(),
            elements,
            text: bodyText,
            snapshotRef: `snap-${Date.now().toString(36)}`,
            observations: [{ kind: "url", expected: beforeUrl, observed: activePage.url(), required: false }],
          },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.SCREENSHOT) {
        const file = path.join(root, ".ues-cache", "browser-v1", `worker-${Date.now().toString(36)}.png`)
        await activePage.screenshot({ path: file, fullPage: false })
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: {
            ...base,
            finalUrl: activePage.url(),
            screenshotRef: path.relative(root, file).replaceAll("\\", "/"),
          },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.FILL || operation === BROWSER_WORKER_OPERATION.TYPE) {
        const target = await resolveTarget(payload)
        const value = String(payload.text ?? "")
        if (operation === BROWSER_WORKER_OPERATION.FILL) await target.fill(value, { timeout })
        else await target.type(value, { timeout })
        const observed = await target.inputValue().catch(() => "")
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: {
            ...base,
            finalUrl: activePage.url(),
            filledChars: observed.length,
            // Observed, not assumed: the composer really holds the text now.
            observations: [{
              kind: "text-present",
              expected: `non-empty prompt (${value.length} chars)`,
              observed: observed.length > 0,
              required: true,
            }],
          },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.CLICK || operation === BROWSER_WORKER_OPERATION.PRESS || operation === BROWSER_WORKER_OPERATION.SELECT || operation === BROWSER_WORKER_OPERATION.HOVER) {
        const target = await resolveTarget(payload)
        const urlBefore = activePage.url()
        if (operation === BROWSER_WORKER_OPERATION.CLICK) await target.click({ timeout })
        else if (operation === BROWSER_WORKER_OPERATION.PRESS) await target.press(payload.selector || "Enter", { timeout })
        else if (operation === BROWSER_WORKER_OPERATION.SELECT) await target.selectOption(payload.text || payload.selector || "", { timeout })
        else await target.hover({ timeout })
        await activePage.waitForLoadState("domcontentloaded", { timeout }).catch(() => {})
        const urlAfter = activePage.url()
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: {
            ...base,
            finalUrl: urlAfter,
            documentChanged: urlAfter !== urlBefore,
            inputCleared: false,
            observations: [{
              kind: "url",
              expected: urlBefore,
              observed: urlAfter,
              required: false,
            }],
          },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.WAIT) {
        await activePage.waitForTimeout(boundedInt(payload.timeoutMs, 1_000, 0, 15_000))
        return encodeWorkerResponse({
          ok: true,
          requestId: payload.requestId,
          operation,
          payload: { ...base, finalUrl: activePage.url() },
        })
      }
      if (operation === BROWSER_WORKER_OPERATION.CLOSE) {
        return encodeWorkerResponse({ ok: true, requestId: payload.requestId, operation, payload: { ...base } })
      }
      return encodeWorkerResponse({
        ok: false,
        requestId: payload.requestId,
        operation,
        failure: BROWSER_WORKER_FAILURE.UNKNOWN_ACTION,
      })
    } catch (error) {
      const message = String(error?.message || error)
      const failure = error?.code === BROWSER_WORKER_FAILURE.UNAVAILABLE
        ? BROWSER_WORKER_FAILURE.UNAVAILABLE
        : /timeout/i.test(message)
          ? BROWSER_WORKER_FAILURE.TIMEOUT
          : /login|sign in|unauthorized|401/i.test(message)
            ? BROWSER_WORKER_FAILURE.AUTH_REQUIRED
            : BROWSER_WORKER_FAILURE.PROVIDER_ERROR
      return encodeWorkerResponse({
        ok: false,
        requestId: String(request?.requestId || ""),
        operation,
        failure,
        payload: { detail: message.slice(0, 400) },
      })
    }
  }

  async function shutdown() {
    try { await page?.close() } catch {}
    try { await browser?.close() } catch {}
  }

  if (process.argv.includes("--probe")) {
    const response = await handle({
      operation: BROWSER_WORKER_OPERATION.CAPABILITY,
      requestId: "probe",
      protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
    })
    process.stdout.write(JSON.stringify(response) + "\n")
    await shutdown()
    return
  }

  let buffer = ""
  process.stdin.setEncoding("utf8")
  // Serialized: one operation at a time keeps the page state deterministic.
  let queue = Promise.resolve()
  process.stdin.on("data", (chunk) => {
    buffer += String(chunk || "")
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (!line) continue
      let request = null
      try {
        request = JSON.parse(line)
      } catch {
        continue
      }
      const decoded = decodeWorkerResponse({ protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, ok: true, payload: request })
      void decoded
      if (request.operation === BROWSER_WORKER_OPERATION.CLOSE) {
        queue = queue.then(async () => {
          process.stdout.write(JSON.stringify(encodeWorkerResponse({
            ok: true,
            requestId: String(request.requestId || ""),
            operation: request.operation,
            payload: {},
          })) + "\n")
          await shutdown()
          process.exit(0)
        })
        continue
      }
      queue = queue.then(async () => {
        const response = await handle(request)
        process.stdout.write(JSON.stringify(response) + "\n")
      }).catch(() => {})
    }
  })
  process.stdin.on("end", () => {
    queue = queue.then(shutdown).catch(() => {})
  })
  process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)) })
  process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)) })
}

main().catch((error) => {
  process.stdout.write(JSON.stringify(encodeWorkerResponse({
    ok: false,
    requestId: "startup",
    operation: "capability",
    failure: BROWSER_WORKER_FAILURE.PROVIDER_ERROR,
    payload: { detail: String(error?.message || error).slice(0, 400) },
  })) + "\n")
  process.exitCode = 1
})

// Kept referenced so the protocol import is not tree-shaken into an unused value
// by a bundler that cannot see the worker entry point's dynamic dispatch.
void classifyWorkerOperation