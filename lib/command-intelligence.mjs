const DIRECT_VERIFY = /\b(?:jest|vitest|pytest|node\s+--test|tsc|eslint|ruff|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i
const VERIFY_SCRIPT = /^(?:test|lint|typecheck|build)(?::|$)/i

function shellWords(command) {
  return String(command || "").match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) =>
    word.replace(/^["']|["']$/g, ""),
  ) || []
}

function packageManagerVerificationFamily(command) {
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
      const match = token.match(VERIFY_SCRIPT)
      if (!match) continue
      const script = String(match[0] || token).split(":")[0].toLowerCase()
      if (script === "test") return "test"
      if (script === "lint" || script === "typecheck") return "diagnostics"
      if (script === "build") return "build"
      return "verification"
    }
  }
  return null
}

function directVerificationFamily(command) {
  const raw = String(command || "")
  if (/\b(?:jest|vitest|pytest|node\s+--test|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(raw)) return "test"
  if (/\b(?:tsc|eslint|ruff)\b/i.test(raw)) return "diagnostics"
  return null
}
const SERVER = /\b(?:next\s+(?:dev|start)|nest\s+start|vite(?:\s|$)|webpack\s+serve|expo\s+start|react-native\s+start|node\s+.+server|npm\s+run\s+(?:dev|start))\b/i
const HIDES_PROGRESS = /(?:\||\|&)\s*(?:tail|head|grep|rg|sed|awk)\b|(?:>|>>)\s*[^&]/i

function shellSyntaxView(command) {
  const source = String(command || "")
  let quote = ""
  let escaped = false
  let view = ""
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (escaped) {
      view += " "
      escaped = false
      continue
    }
    if (ch === "\\" && quote !== "'") {
      view += " "
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ""
      view += " "
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      view += " "
      continue
    }
    view += ch
  }
  return view
}

function hidesProgressPipeline(command) {
  return HIDES_PROGRESS.test(shellSyntaxView(command))
}

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
  const syntax = shellSyntaxView(raw)
  const verificationFamily = directVerificationFamily(syntax) || packageManagerVerificationFamily(raw)
  const verificationLike = Boolean(verificationFamily) || DIRECT_VERIFY.test(syntax)
  const longRunningService = SERVER.test(syntax)
  const hidesProgress = hidesProgressPipeline(raw)
  const configuredTimeoutSec = Math.max(1, Number(options.verificationTimeoutSec || 300))
  return {
    schemaVersion: 1,
    command: raw,
    verificationLike,
    verificationFamily,
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
