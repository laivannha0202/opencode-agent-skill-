import { readdir } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { checkExtensionSyntax } from "./check-extension-types.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const roots = ["bin", "lib", "scripts", "test", "global-config/plugins", "evals/live/graders", "evals/live/fixtures", "evals/long/graders", "evals/long/fixtures", "pi/extensions"]
const files = []
const extensionFiles = []

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name)) files.push(full)
  }
}

async function walkExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ts$/.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    extensionFiles.push(full)
  }
}

for (const relative of roots) await walk(path.join(root, relative))
// `node --check` cannot read TypeScript, so the extension sources are collected
// separately and parsed by the runtime's own TypeScript parser. Without this the
// Pi extensions were outside the syntax gate entirely.
await walkExtensions(path.join(root, "pi/extensions"))

const errors = []
for (const file of files.sort()) {
  const run = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
  if (run.status !== 0) {
    errors.push(`${path.relative(root, file)}\n${run.stderr || run.stdout || "syntax check failed"}`)
  }
}

const extensionReport = await checkExtensionSyntax(path.join(root, "pi/extensions"))
for (const error of extensionReport.errors) errors.push(`${path.relative(root, "pi/extensions")}/${error}`)

if (errors.length) {
  console.error("JavaScript syntax validation failed:")
  for (const error of errors) console.error("\n" + error)
  process.exit(1)
}

console.log(`Syntax-checked ${files.length} JavaScript module files and ${extensionReport.checked} Pi extension TypeScript files.`)
