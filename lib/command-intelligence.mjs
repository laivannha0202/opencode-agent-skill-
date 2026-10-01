const VERIFY_SCRIPT = /^(?:test|lint|typecheck|build)(?::|$)/i

function shellWords(command) {
  return String(command || "").match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) =>
    word.replace(/^["']|["']$/g, ""),
  ) || []
}

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

function simpleShellSegments(command) {
  return shellSyntaxView(command)
    .split(/&&|\|\||\|&|[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function executableWords(segment) {
  const words = shellWords(segment)
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1
  if (String(words[index] || "").toLowerCase() === "env") {
    index += 1
    while (index < words.length) {
      const token = String(words[index] || "")
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || /^-[A-Za-z]/.test(token)) {
        index += 1
        continue
      }
      break
    }
  }
  return words.slice(index)
}

function executableSegments(command) {
  return simpleShellSegments(command)
    .map(executableWords)
    .filter((words) => words.length > 0)
}

function executableName(words) {
  return String(words?.[0] || "").replace(/^.*[\\/]/, "").toLowerCase()
}

function packageManagerVerificationFamily(command) {
  for (const words of executableSegments(command)) {
    const word = executableName(words)
    if (!["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(word)) continue
    for (let j = 1; j < Math.min(words.length, 14); j += 1) {
      const token = String(words[j] || "")
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

function packageManagerLongRunningService(command) {
  for (const words of executableSegments(command)) {
    const word = executableName(words)
    if (!["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(word)) continue
    for (let j = 1; j < Math.min(words.length, 14); j += 1) {
      const token = String(words[j] || "").toLowerCase()
      if (token === "run" || token === "run-script") continue
      if (/^(?:dev|start|serve|preview|watch)(?::|$)/i.test(token)) return true
    }
  }
  return false
}

function directVerificationFamily(command) {
  for (const words of executableSegments(command)) {
    const name = executableName(words)
    const lower = words.map((word) => String(word).toLowerCase())
    if (["jest", "vitest", "pytest"].includes(name)) return "test"
    if (["tsc", "eslint", "ruff", "pylint", "flake8"].includes(name)) return "diagnostics"
    if (name === "node" && lower.includes("--test")) return "test"
    if (name === "go" && lower[1] === "test") return "test"
    if (name === "cargo" && lower[1] === "test") return "test"
    if (name === "dotnet" && lower[1] === "test") return "test"
    if (["mvn", "mvn.cmd", "gradle", "gradle.bat", "gradlew", "gradlew.bat"].includes(name) && lower.some((token) => token === "test" || token.endsWith(":test"))) return "test"
    if (["npx", "pnpx", "bunx"].includes(name) && ["jest", "vitest", "tsc", "eslint", "ruff"].includes(String(lower[1] || ""))) {
      return ["tsc", "eslint", "ruff"].includes(String(lower[1])) ? "diagnostics" : "test"
    }
  }
  return null
}

function directLongRunningService(command) {
  for (const words of executableSegments(command)) {
    const name = executableName(words)
    const lower = words.map((word) => String(word).toLowerCase())
    if (name === "next" && ["dev", "start"].includes(String(lower[1] || ""))) return true
    if (name === "nest" && lower[1] === "start") return true
    if (name === "vite") return true
    if (name === "webpack" && lower[1] === "serve") return true
    if (name === "expo" && lower[1] === "start") return true
    if (name === "react-native" && lower[1] === "start") return true
    if (["uvicorn", "gunicorn"].includes(name)) return true
    if (name === "flask" && lower[1] === "run") return true
    if (name === "dotnet" && lower[1] === "run") return true
    if (name === "mvn" && lower.some((token) => token === "spring-boot:run")) return true
    if (["gradle", "gradlew", "gradlew.bat"].includes(name) && lower.some((token) => token === "bootrun")) return true
    if (name === "docker" && lower[1] === "compose" && lower[2] === "up" && !lower.includes("-d")) return true
    if (["node", "bun"].includes(name) && lower.some((token, index) => index > 0 && /(?:^|[\\/])(?:main|server|app)\.(?:mjs|cjs|js|ts)$/.test(token))) return true
    if (["python", "python3", "py"].includes(name)) {
      if (lower[1] === "-m" && lower[2] === "http.server") return true
      if (lower.some((token) => token.includes("uvicorn") || token.includes("gunicorn"))) return true
      if (lower.some((token, index) => token.endsWith("manage.py") && lower[index + 1] === "runserver")) return true
    }
  }
  return false
}

const HIDES_PROGRESS = /(?:\||\|&)\s*(?:tail|head|grep|rg|sed|awk)\b|(?:>|>>)\s*[^&]/i

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
  const verificationFamily = directVerificationFamily(raw) || packageManagerVerificationFamily(raw)
  const verificationLike = Boolean(verificationFamily)
  const longRunningService = directLongRunningService(raw) || packageManagerLongRunningService(raw)
  const hidesProgress = hidesProgressPipeline(raw)
  const configuredTimeoutSec = Math.max(1, Number(options.verificationTimeoutSec || 300))
  return {
    schemaVersion: 2,
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
