import { spawnSync } from "node:child_process"

export function parseOpenCodeMajor(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? Number(match[1]) : null
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

export function adaptAgentForOpenCode(source, major) {
  if (major < 2) return source

  return source.replace(
    /permission:\s*\r?\n\s+edit:\s*deny\s*\r?\n\s+write:\s*deny/m,
    'permissions:\n  - action: edit\n    resource: "*"\n    effect: deny',
  )
}
