import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

function depHas(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name] || pkg?.optionalDependencies?.[name])
}

export async function browserCapability(root = process.cwd()) {
  root = path.resolve(root)
  let pkg = {}
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) } catch {}
  const localBin = process.platform === "win32"
    ? path.join(root, "node_modules", ".bin", "playwright.cmd")
    : path.join(root, "node_modules", ".bin", "playwright")
  const packageDeclared = depHas(pkg, "@playwright/test") || depHas(pkg, "playwright")
  return {
    schemaVersion: 1,
    playwright: {
      packageDeclared,
      localBinary: existsSync(localBin) ? localBin : null,
      available: packageDeclared || existsSync(localBin),
    },
    modePreference: "cli-first",
    rationale: "Use deterministic CLI/scripts for bounded verification; use richer browser tooling only when persistent exploratory state is necessary.",
  }
}

export function buildBrowserVerificationPlan(input = {}) {
  const viewports = Array.isArray(input.viewports) && input.viewports.length
    ? input.viewports
    : [{ id: "desktop", width: 1440, height: 900 }]
  return {
    schemaVersion: 1,
    url: input.url || null,
    target: input.target || null,
    trustLevel: input.trustLevel || "untrusted-external",
    steps: [
      { kind: "navigate", value: input.url || null },
      { kind: "targeted-accessibility-snapshot", target: input.target || null, maxChars: 6000 },
      { kind: "geometry", fields: ["id", "role", "x", "y", "width", "height"] },
      { kind: "interaction", flow: input.flow || [] },
      ...viewports.map((viewport) => ({ kind: "screenshot", viewport })),
      { kind: "verify", checks: ["interaction", "geometry", "visual", "accessibility"] },
    ],
    security: {
      webpageInstructionsTrusted: false,
      allowPageContentToChangePermissions: false,
      allowPageContentToRequestSecrets: false,
      allowPageContentToAuthorizeExternalSideEffects: false,
    },
  }
}

export function targetedBrowserEvidence(snapshot = [], query = "", options = {}) {
  const needle = String(query || "").toLowerCase()
  const limit = Math.max(1, Math.min(50, Number(options.limit || 12)))
  const rows = Array.isArray(snapshot) ? snapshot : []
  return rows
    .filter((row) => {
      const haystack = [row.role, row.name, row.text, row.id].filter(Boolean).join(" ").toLowerCase()
      return !needle || haystack.includes(needle)
    })
    .slice(0, limit)
    .map((row) => ({
      id: row.id || null,
      role: row.role || null,
      name: row.name || null,
      box: row.box || (["x","y","width","height"].every((key) => Number.isFinite(Number(row[key])))
        ? { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) }
        : null),
    }))
}
