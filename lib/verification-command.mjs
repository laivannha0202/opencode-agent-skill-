export const VERIFICATION_COMMAND_RE =
  /(?:^|\s|&&|;|\|)(?:pnpm|npm|yarn|bun|npx|node|python|pytest|go|cargo|dotnet|mvn|gradle|\.\/gradlew|gradlew\.bat)[^\n]*(?:test|jest|vitest|pytest|typecheck|tsc|lint|eslint|ruff|mypy|check|build|compile)/i

export function looksLikeVerificationCommand(command = "") {
  return VERIFICATION_COMMAND_RE.test(String(command || ""))
}

export function hasMaskedShellExitRisk(command = "") {
  const value = String(command || "")
  // Receipt reuse is an optimization, so ambiguity fails closed. Quoted shell
  // metacharacters may cause a false negative here, which only means rerunning
  // the check; it can never create a false PASS receipt.
  if (value.includes("||") || value.includes(";") || value.includes("|") || /\r|\n/.test(value)) {
    return true
  }
  // Reject a single/background '&' while allowing '&&'.
  const withoutAndAnd = value.replaceAll("&&", "")
  if (withoutAndAnd.includes("&")) return true
  return false
}

export function canRecordReusableVerification(command = "") {
  const value = String(command || "").trim()
  return Boolean(value) &&
    looksLikeVerificationCommand(value) &&
    !hasMaskedShellExitRisk(value)
}

function tokenizeSimpleShell(command) {
  const value = String(command || "").trim()
  if (!value || hasMaskedShellExitRisk(value)) return null
  // Fail closed on shell constructs whose meaning depends on expansion or
  // redirection. Receipt reuse is only an optimization.
  if (/[<>]/.test(value) || value.includes("\u0060") || /\$\(|\$\{|\*|\?|\[|\]/.test(value)) return null

  const tokens = []
  let current = ""
  let quote = null
  let escaped = false

  const push = () => {
    if (!current) return
    tokens.push(current)
    current = ""
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
  }

  if (escaped || quote) return null
  push()
  return tokens.length ? tokens : null
}

export function canonicalVerificationCommand(command = "") {
  const value = String(command || "").trim()
  if (!canRecordReusableVerification(value)) return null

  const tokens = tokenizeSimpleShell(value)
  if (!tokens?.length) return null

  const first = String(tokens[0] || "").toLowerCase()
  if ((first === "cmd" || first === "cmd.exe") && /^\/c$/i.test(tokens[1] || "")) {
    if (tokens.length < 3) return null
    return { command: tokens[2], args: tokens.slice(3), raw: value }
  }

  // PowerShell -Command is intentionally not canonicalized: quoting and command
  // parsing semantics are too rich for a safe exact-reuse key.
  if (first === "powershell" || first === "powershell.exe" || first === "pwsh" || first === "pwsh.exe") {
    return null
  }

  return {
    command: tokens[0],
    args: tokens.slice(1),
    raw: value,
  }
}
