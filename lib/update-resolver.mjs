function parseJsonString(stdout) {
  try {
    const value = JSON.parse(String(stdout || "").trim())
    return typeof value === "string" && value ? value : null
  } catch {
    return null
  }
}

function parseLatestTag(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^latest:\s*(\S+)$/)
    if (match) return match[1]
  }
  return null
}

export function resolveLatestPublishedVersion({ runCapture, packageName, cwd }) {
  const direct = runCapture(
    "npm",
    ["view", `${packageName}@latest`, "version", "--json"],
    { cwd },
  )
  if (direct.status === 0) {
    const version = parseJsonString(direct.stdout)
    if (version) return { version, source: "view@latest" }
  }

  const tags = runCapture("npm", ["dist-tag", "ls", packageName], { cwd })
  if (tags.status === 0) {
    const version = parseLatestTag(tags.stdout)
    if (version) return { version, source: "dist-tag" }
  }

  const detail = [direct.stderr, direct.stdout, tags.stderr, tags.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n")

  const error = new Error("Could not resolve npm latest dist-tag safely." + (detail ? "\n" + detail : ""))
  error.exitCode = direct.status || tags.status || 1
  throw error
}
