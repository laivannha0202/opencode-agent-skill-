const DIRECT_VERIFY = /\b(?:jest|vitest|pytest|node\s+--test|tsc|eslint|ruff|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i
const VERIFY_SCRIPT = /^(?:test|lint|typecheck|build)(?::|$)/i

function shellWords(command) {
  return String(command || "").match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) =>
    word.replace(/^["']|["']$/g, ""),
  ) || []
}

function packageManagerVerification(command) {
  const words = shellWords(command)
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i].replace(/^.*[\\/]/, "").toLowerCase()
    if (!["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(word)) continue
    // Workspace/filter selectors may appear between the package manager and
    // script (for example: npm --filter @scope/pkg test). Bound the scan to
    // the current simple shell segment so an unrelated later command does not
    // turn this one into a verification classification.
    for (let j = i + 1; j < Math.min(words.length, i + 14); j += 1) {
      const token = words[j]
      if (/^(?:&&|\|\||;|\||\|&)$/.test(token)) break
      if (token === "run" || token === "run-script") continue
      if (VERIFY_SCRIPT.test(token)) return true
    }
  }
  return false
}
const SERVER = /\b(?:next\s+(?:dev|start)|nest\s+start|vite(?:\s|$)|webpack\s+serve|expo\s+start|react-native\s+start|node\s+.+server|npm\s+run\s+(?:dev|start))\b/i
const HIDES_PROGRESS = /(?:\||\|&)\s*(?:tail|head|grep|rg|sed|awk)\b|(?:>|>>)\s*[^&]/i

export function boundedVerificationTimeout(analysis = {}, requestedTimeout, configuredTimeout = 300) {
  const configured = Math.max(1, Number(configuredTimeout || 300))
  const requested = Number(requestedTimeout)
  if (analysis?.verificationLike !== true) {
    return Number.isFinite(requested) && requested > 0 ? requested : null
  }
  if (!Number.isFinite(requested) || requested <= 0 || requested > configured) return configured
  return requested
}

export function analyzeShellCommand(command, options = {}) {
  const raw = String(command || "").trim()
  const verificationLike = DIRECT_VERIFY.test(raw) || packageManagerVerification(raw)
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
