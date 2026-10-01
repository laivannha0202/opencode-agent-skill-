const VERIFY = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|typecheck|build)\b|\b(?:jest|vitest|pytest|node\s+--test|tsc|eslint|ruff|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i
const SERVER = /\b(?:next\s+(?:dev|start)|nest\s+start|vite(?:\s|$)|webpack\s+serve|expo\s+start|react-native\s+start|node\s+.+server|npm\s+run\s+(?:dev|start))\b/i
const HIDES_PROGRESS = /(?:\||\|&)\s*(?:tail|head|grep|rg|sed|awk)\b|(?:>|>>)\s*[^&]/i

export function analyzeShellCommand(command, options = {}) {
  const raw = String(command || "").trim()
  const verificationLike = VERIFY.test(raw)
  const longRunningService = SERVER.test(raw)
  const hidesProgress = HIDES_PROGRESS.test(raw)
  const configuredTimeoutSec = Math.max(1, Number(options.verificationTimeoutSec || 300))
  return {
    schemaVersion: 1,
    command: raw,
    verificationLike,
    longRunningService,
    hidesProgress,
    progressVisibility: hidesProgress ? "reduced-by-shell-pipeline" : "direct",
    recommendedTimeoutSec: verificationLike ? configuredTimeoutSec : null,
    shouldUseManagedService: longRunningService,
    finding: hidesProgress && verificationLike
      ? "verification-output-hidden-by-pipeline"
      : longRunningService
        ? "long-running-service-command"
        : null,
  }
}
