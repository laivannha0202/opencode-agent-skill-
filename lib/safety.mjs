const RULES = [
  { id: "git-force", pattern: /\bgit\s+(?:push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))|reset\s+--hard|clean\s+-[^\n]*f)/i },
  { id: "history-rewrite", pattern: /\bgit\s+(?:rebase\b|filter-branch\b|filter-repo\b)/i },
  { id: "publish", pattern: /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/i },
  { id: "destructive-files", pattern: /(?:^|[;&|]\s*)(?:rm\s+-[^\n]*r[^\n]*f|rmdir\s+\/s|del\s+\/s|remove-item\b[^\n]*-recurse[^\n]*-force)/i },
  { id: "database-drop", pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i },
  { id: "deployment", pattern: /\b(?:kubectl\s+(?:delete|apply)|terraform\s+(?:apply|destroy)|helm\s+(?:install|upgrade|uninstall))\b/i },
]

export function shellCommandSegments(command) {
  const value = String(command || "")
  const segments = []
  let current = ""
  let quote = null
  let escaped = false
  let depth = 0

  const push = (operator = null) => {
    const text = current.trim()
    if (text) segments.push({ text, operator })
    current = ""
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1] || ""

    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1
      current += char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (depth === 0 && char === "&" && next === "&") {
      push("&&")
      index += 1
      continue
    }
    if (depth === 0 && char === "|" && next === "|") {
      push("||")
      index += 1
      continue
    }
    if (depth === 0 && (char === ";" || char === "|")) {
      push(char)
      continue
    }
    if (depth === 0 && char === "\n") {
      push("\n")
      continue
    }
    current += char
  }
  push(null)
  return segments
}

export function destructiveShellAnalysis(command) {
  const value = String(command || "")
  const segments = shellCommandSegments(value)
  const findings = []

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    for (const rule of RULES) {
      // Clone regex state defensively if future rules add the global flag.
      rule.pattern.lastIndex = 0
      if (!rule.pattern.test(segment.text)) continue
      findings.push({
        id: rule.id,
        segmentIndex: index,
        segment: segment.text,
        operator: segment.operator,
      })
      break
    }
  }

  // Retain a whole-command fallback so nested shell syntax that the bounded
  // splitter intentionally does not fully parse still fails closed.
  if (!findings.length) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(value)) {
        findings.push({ id: rule.id, segmentIndex: null, segment: value, operator: null })
        break
      }
    }
  }

  return {
    risky: findings.length > 0,
    id: findings[0]?.id || null,
    findings,
    segmentCount: segments.length,
  }
}

export function destructiveShellRisk(command) {
  const analysis = destructiveShellAnalysis(command)
  return {
    risky: analysis.risky,
    id: analysis.id,
    segmentIndex: analysis.findings[0]?.segmentIndex ?? null,
    segment: analysis.findings[0]?.segment || null,
  }
}