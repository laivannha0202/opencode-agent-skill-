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
