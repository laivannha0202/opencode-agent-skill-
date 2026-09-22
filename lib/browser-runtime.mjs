import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function safeUrl(value) {
  let parsed
  try { parsed = new URL(String(value || "")) } catch { throw new Error("Browser inspect requires a valid http(s) URL") }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Browser inspect only allows http(s) URLs")
  return parsed.toString()
}

function safeOutput(root, url, requested = null) {
  const base = path.resolve(root)
  const dir = path.join(base, ".ues-cache", "browser-v1")
  if (!requested) {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 20)
    return { dir, file: path.join(dir, hash + ".png") }
  }
  const target = path.resolve(base, String(requested))
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Browser screenshot path must stay inside the project root")
  }
  return { dir: path.dirname(target), file: target }
}

function loadPlaywright(root) {
  const requireFromProject = createRequire(path.join(path.resolve(root), "package.json"))
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      const mod = requireFromProject(name)
      if (mod?.chromium) return mod
      if (mod?.default?.chromium) return mod.default
    } catch {}
  }
  throw new Error("Playwright is unavailable in this project. Add playwright or @playwright/test before browser inspection.")
}

function roleForElement(el) {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute("type") || "").toLowerCase()
  if (tag === "button") return "button"
  if (tag === "a" && el.hasAttribute("href")) return "link"
  if (tag === "img") return "img"
  if (/^h[1-6]$/.test(tag)) return "heading"
  if (tag === "input") {
    if (["button","submit","reset"].includes(type)) return "button"
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    return "textbox"
  }
  if (tag === "textarea") return "textbox"
  if (tag === "select") return "combobox"
  return tag
}

export async function inspectBrowserPage(root = process.cwd(), url, options = {}) {
  root = path.resolve(root)
  const targetUrl = safeUrl(url)
  const maxElements = boundedInt(options.maxElements, 80, 1, 250)
  const timeoutMs = boundedInt(options.timeoutMs, 30_000, 1_000, 120_000)
  const viewport = {
    width: boundedInt(options.width, 1440, 240, 7680),
    height: boundedInt(options.height, 900, 240, 4320),
  }
  const output = safeOutput(root, targetUrl, options.screenshot)
  await mkdir(output.dir, { recursive: true })

  const playwright = loadPlaywright(root)
  const browser = await playwright.chromium.launch({ headless: true })
  let page
  try {
    page = await browser.newPage({ viewport })
    await page.goto(targetUrl, { waitUntil: options.waitUntil || "domcontentloaded", timeout: timeoutMs })
    if (options.waitMs) await page.waitForTimeout(boundedInt(options.waitMs, 0, 0, 15_000))

    const selector = options.selector ? String(options.selector) : null
    const raw = await page.evaluate(({ maxElements, selector }) => {
      const clean = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
      const candidateSelector = selector || [
        "button","a[href]","input","textarea","select","img",
        "h1","h2","h3","h4","h5","h6",
        "[role]","[tabindex]","[data-testid]"
      ].join(",")
      let nodes = []
      try { nodes = Array.from(document.querySelectorAll(candidateSelector)) } catch { nodes = [] }
      return nodes.slice(0, maxElements).map((el, index) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.textContent ||
          ""
        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          name: clean(name),
          text: clean(el.textContent),
          id: el.id || null,
          testId: el.getAttribute("data-testid") || null,
          box: {
            x: Number(rect.x.toFixed(2)),
            y: Number(rect.y.toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
          },
          visible: Boolean(rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"),
          style: {
            display: style.display,
            position: style.position,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
          },
        }
      })
    }, { maxElements, selector })

    const elements = raw.map((item) => ({
      ...item,
      role: item.role || roleForElement({
        getAttribute: (name) => {
          if (name === "role") return item.role
          if (name === "type") return null
          return null
        },
        hasAttribute: () => item.tag === "a",
        tagName: item.tag,
      }),
    }))

    await page.screenshot({ path: output.file, fullPage: options.fullPage !== false })
    const title = await page.title().catch(() => "")
    const finalUrl = page.url()

    return {
      schemaVersion: 1,
      trustLevel: "untrusted-external",
      requestedUrl: targetUrl,
      finalUrl,
      title,
      viewport,
      selector,
      elementCount: elements.length,
      elements,
      screenshot: path.relative(root, output.file).replaceAll("\\", "/"),
      security: {
        pageContentIsInstruction: false,
        allowPageContentToChangePermissions: false,
        allowPageContentToRequestSecrets: false,
        allowPageContentToAuthorizeExternalSideEffects: false,
      },
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

export function summarizeBrowserInspection(report = {}, options = {}) {
  const limit = boundedInt(options.limit, 20, 1, 100)
  return {
    schemaVersion: 1,
    trustLevel: report.trustLevel || "untrusted-external",
    finalUrl: report.finalUrl || report.requestedUrl || null,
    title: report.title || null,
    viewport: report.viewport || null,
    screenshot: report.screenshot || null,
    elementCount: Number(report.elementCount || report.elements?.length || 0),
    elements: (report.elements || []).slice(0, limit).map((item) => ({
      index: item.index,
      role: item.role || null,
      name: item.name || null,
      id: item.id || null,
      testId: item.testId || null,
      box: item.box || null,
      visible: item.visible !== false,
    })),
  }
}
