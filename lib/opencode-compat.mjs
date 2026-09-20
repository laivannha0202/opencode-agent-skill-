import { spawnSync } from "node:child_process"

export function parseOpenCodeMajor(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? Number(match[1]) : null
}

export function capabilitiesFromHelp(versionOutput, runHelpOutput = "") {
  const major = parseOpenCodeMajor(versionOutput)
  const help = String(runHelpOutput || "")
  return {
    schemaVersion: 1,
    major,
    supportsStandalone: /(?:^|[^A-Za-z0-9_-])--standalone(?:[^A-Za-z0-9_-]|$)/m.test(help),
    supportsJsonFormat: /(?:^|[^A-Za-z0-9_-])--format(?:[^A-Za-z0-9_-]|$)/m.test(help) && /json/i.test(help),
    supportsAgentFlag: /(?:^|[^A-Za-z0-9_-])--agent(?:[^A-Za-z0-9_-]|$)/m.test(help),
    supportsModelFlag: /(?:^|[^A-Za-z0-9_-])--model(?:[^A-Za-z0-9_-]|$)/m.test(help),
    supportsDirFlag: /(?:^|[^A-Za-z0-9_-])--dir(?:[^A-Za-z0-9_-]|$)/m.test(help),
  }
}

export function detectOpenCodeCapabilities() {
  const versionRun = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const helpRun = spawnSync("opencode", ["run", "--help"], { encoding: "utf8" })
  return capabilitiesFromHelp(
    versionRun.status === 0 ? versionRun.stdout || versionRun.stderr : "",
    helpRun.status === 0 ? helpRun.stdout || helpRun.stderr : "",
  )
}

export function detectOpenCodeMajor() {
  const forced = process.env.UES_OPENCODE_MAJOR
  if (forced && /^\d+$/.test(forced)) return Number(forced)

  const candidates = process.platform === "win32"
    ? [
        () => spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "opencode --version"], { encoding: "utf8" }),
        () => spawnSync("opencode", ["--version"], { encoding: "utf8" }),
      ]
    : [() => spawnSync("opencode", ["--version"], { encoding: "utf8" })]

  for (const run of candidates) {
    const result = run()
    if (result.status !== 0) continue
    const major = parseOpenCodeMajor(result.stdout || result.stderr)
    if (major !== null) return major
  }
  return 1
}

export function buildOpenCodeRunArgs({ major = 1, capabilities = null, model, workspace, variant = null, prompt }) {
  const args = ["run"]
  const standalone = capabilities?.supportsStandalone ?? Number(major) >= 2
  if (standalone) args.push("--standalone")
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
