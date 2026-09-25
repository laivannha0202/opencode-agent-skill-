import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveWindowsCommand } from "../lib/windows-shim.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function run(executable, args, options = {}) {
  if (process.platform !== "win32") return spawnSync(executable, args, options)
  const resolved = resolveWindowsCommand(executable)
  if (!resolved) {
    return { status: 127, stdout: "", stderr: "Unable to resolve Windows command: " + executable }
  }
  return spawnSync(resolved.executable, [...resolved.argsPrefix, ...args], options)
}

function parseJsonOutput(result, label) {
  assert.equal(result.status, 0, label + " failed: " + String(result.stderr || result.stdout || ""))
  return JSON.parse(String(result.stdout || "").trim())
}

const packed = parseJsonOutput(
  run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }),
  "npm pack --dry-run",
)

assert.ok(Array.isArray(packed) && packed.length >= 1, "npm pack did not return package metadata")
const files = new Set((packed[0].files || []).map((entry) => String(entry.path).replaceAll("\\", "/")))

for (const required of [
  "bin/ocskill.mjs",
  "pi/extensions/ues.ts",
  "pi/extensions/ues-child-runtime.ts",
  "docs/V14.2-TURBO-WEAK-MODEL-RUNTIME.md",
  "lib/process-supervisor.mjs",
  "lib/pi-rpc-pool.mjs",
  "lib/adaptive-context-budget.mjs",
  "lib/skill-compiler.mjs",
  "lib/affected-tests.mjs",
  "lib/verification-broker.mjs",
  "lib/verification-command.mjs",
  "lib/task-policy.mjs",
  "lib/model-policy.mjs",
  "lib/context-engine-v11.mjs",
  "lib/runtime-config.mjs",
  "scripts/eval-pi.mjs",
  "scripts/eval-report.mjs",
  "evals/live/tasks.json",
  "global-config/AGENTS.md",
  "global-config/commands/run.md",
  "global-config/plugins/ues-router/index.js",
]) {
  assert.ok(files.has(required), "packed package is missing required runtime file: " + required)
}

const controllerStat = (packed[0].files || []).find((entry) => String(entry.path).replaceAll("\\", "/") === "pi/extensions/ues.ts")
assert.ok(Number(controllerStat?.size || 0) > 80_000, "packed UES controller appears truncated")

const childRuntimeStat = (packed[0].files || []).find((entry) => String(entry.path).replaceAll("\\", "/") === "pi/extensions/ues-child-runtime.ts")
assert.ok(Number(childRuntimeStat?.size || 0) > 6_000, "packed UES child runtime appears truncated")

const codeFiles = [...files].filter((file) => /\.(?:mjs|js|ts)$/.test(file))
const missingRelativeImports = []

function resolvePackedImport(fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, base + ".mjs", base + ".js", base + ".ts", path.posix.join(base, "index.mjs"), path.posix.join(base, "index.js")]
  return candidates.find((candidate) => existsSync(path.join(root, ...candidate.split("/")))) || null
}

for (const file of codeFiles) {
  const absolute = path.join(root, ...file.split("/"))
  if (!existsSync(absolute)) continue
  const source = readFileSync(absolute, "utf8")
  const regex = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)[\"'](\.{1,2}\/[^\"']+)[\"']/g
  let match
  while ((match = regex.exec(source))) {
    const resolved = resolvePackedImport(file, match[1])
    if (resolved && !files.has(resolved)) {
      missingRelativeImports.push({ from: file, import: match[1], resolved })
    }
  }
}

assert.deepEqual(
  missingRelativeImports,
  [],
  "packed runtime has relative imports to files excluded from npm package: " + JSON.stringify(missingRelativeImports),
)

const taskPolicy = parseJsonOutput(
  run(process.execPath, [path.join(root, "bin", "ocskill.mjs"), "task-policy", "fix a high-risk authentication bug", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }),
  "packaged task-policy smoke",
)
assert.equal(taskPolicy.risk, "high")
assert.equal(taskPolicy.modelTier, "heavy")

console.log(`Package closure smoke passed: ${files.size} packed file(s), ${codeFiles.length} code file(s) checked`)