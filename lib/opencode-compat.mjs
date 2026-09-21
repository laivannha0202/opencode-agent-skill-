import { spawnSync } from "node:child_process"
import { resolveWindowsCommand } from "./windows-shim.mjs"

export function parseOpenCodeMajor(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? Number(match[1]) : null
}


function runOpenCodeVersion() {
  if (process.platform !== "win32") {
    return spawnSync("opencode", ["--version"], { encoding: "utf8" })
  }

  const resolved = resolveWindowsCommand("opencode")
  if (!resolved) {
    return {
      status: 127,
      stdout: "",
      stderr: "no safely executable OpenCode command found",
    }
  }

  return spawnSync(
    resolved.executable,
    [...resolved.argsPrefix, "--version"],
    { encoding: "utf8" },
  )
}

export function detectOpenCodeMajor() {
  const forced = process.env.UES_OPENCODE_MAJOR
  if (forced && /^\d+$/.test(forced)) return Number(forced)

  const result = runOpenCodeVersion()
  if (result.status === 0) {
    const major = parseOpenCodeMajor(result.stdout || result.stderr)
    if (major !== null) return major
  }
  return 1
}

export function buildOpenCodeRunArgs({ major = 1, model, workspace, variant = null, prompt }) {
  const args = ["run"]
  if (Number(major) >= 2) args.push("--standalone")
  args.push(
    "--format",
    "json",
    "--auto",
    "--agent",
    "build",
    "--model",
    model,
    "--dir",
    workspace,
  )
  if (variant) args.push("--variant", variant)
  args.push(prompt)
  return args
}

export function adaptAgentForOpenCode(source, major) {
  if (major < 2) return source

  const lines = String(source).split(/\r?\n/)
  const start = lines.findIndex((line) => /^permission:\s*$/.test(line))
  if (start < 0) return source

  const mappings = {
    bash: "shell",
    task: "subagent",
    write: "edit",
  }
  const rules = []
  const seen = new Set()
  let end = start + 1

  for (; end < lines.length; end += 1) {
    const match = lines[end].match(/^\s{2}([A-Za-z0-9_-]+):\s*(allow|ask|deny)\s*$/)
    if (!match) break
    const action = mappings[match[1]] || match[1]
    const effect = match[2]
    const key = action + ":" + effect
    if (seen.has(key)) continue
    seen.add(key)
    rules.push({ action, effect })
  }

  if (rules.length === 0) return source

  const replacement = ["permissions:"]
  for (const rule of rules) {
    replacement.push(
      "  - action: " + rule.action,
      '    resource: "*"',
      "    effect: " + rule.effect,
    )
  }

  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n")
}
