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
    if (ch === "\\" && quote !== "'" && /["'\\\s|&;<>]/.test(source[i + 1] || "")) {
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
  const source = String(command || "")
  const segments = []
  let current = ""
  let quote = ""
  let escaped = false

  const push = () => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ""
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && quote !== "'" && /["'\\\s|&;<>]/.test(source[i + 1] || "")) {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = ""
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }

    const pair = source.slice(i, i + 2)
    if (pair === "&&" || pair === "||" || pair === "|&") {
      push()
      i += 1
      continue
    }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
      push()
      continue
    }
    current += ch
  }
  push()
  return segments
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

function executableName(words) {
  return String(words?.[0] || "").replace(/^.*[\\/]/, "").toLowerCase()
}

function unwrapExecutableWords(words) {
  let current = [...(words || [])]
  while (current[0] === "&") current = current.slice(1)
  if (!current.length) return { words: current, nested: null }

  const name = executableName(current)
  if (["cmd", "cmd.exe"].includes(name)) {
    const index = current.findIndex((token, i) => i > 0 && /^\/(?:c|k)$/i.test(String(token)))
    if (index >= 0 && index + 1 < current.length) {
      return { words: current, nested: current.slice(index + 1).join(" ") }
    }
  }

  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name)) {
    const index = current.findIndex((token, i) =>
      i > 0 && /^-(?:command|c|commandwithargs)$/i.test(String(token)),
    )
    if (index >= 0 && index + 1 < current.length) {
      return { words: current, nested: current.slice(index + 1).join(" ") }
    }
  }

  if (["sh", "bash", "zsh"].includes(name)) {
    const index = current.findIndex((token, i) =>
      i > 0 && /^-[a-z]*c[a-z]*$/i.test(String(token)),
    )
    if (index >= 0 && index + 1 < current.length) {
      return { words: current, nested: current.slice(index + 1).join(" ") }
    }
  }

  return { words: current, nested: null }
}

function executableSegments(command, depth = 0) {
  const output = []
  for (const segment of simpleShellSegments(command)) {
    const unwrapped = unwrapExecutableWords(executableWords(segment))
    if (!unwrapped.words.length) continue
    if (unwrapped.nested && depth < 4) {
      const nested = executableSegments(unwrapped.nested, depth + 1)
      if (nested.length) {
        output.push(...nested)
        continue
      }
    }
    output.push(unwrapped.words)
  }
  return output
}

function shellAnalysisCommands(command, depth = 0) {
  const raw = String(command || "").trim()
  const output = raw ? [raw] : []
  if (depth >= 4) return output
  for (const segment of simpleShellSegments(raw)) {
    const unwrapped = unwrapExecutableWords(executableWords(segment))
    if (!unwrapped.nested) continue
    output.push(...shellAnalysisCommands(unwrapped.nested, depth + 1))
  }
  return [...new Set(output)]
}

const PACKAGE_MANAGER_NON_SCRIPT = new Set([
  "add", "audit", "config", "create", "dlx", "exec", "help", "init", "install",
  "link", "list", "login", "logout", "outdated", "pack", "publish", "remove",
  "root", "search", "team", "uninstall", "unlink", "update", "view", "why",
])

function packageManagerScript(words) {
  let index = 1
  while (index < words.length) {
    const token = String(words[index] || "")
    const lower = token.toLowerCase()
    if (lower === "run" || lower === "run-script") {
      return String(words[index + 1] || "")
    }
    if (lower === "workspace") {
      index += 2
      if (String(words[index] || "").toLowerCase() === "run") index += 1
      return String(words[index] || "")
    }
    if (/^--(?:filter|workspace|prefix|cwd)$/i.test(token) || /^(?:-c|-C|-w)$/i.test(token)) {
      index += 2
      continue
    }
    if (/^--(?:filter|workspace|prefix|cwd)=/i.test(token)) {
      index += 1
      continue
    }
    if (token.startsWith("-")) {
      index += 1
      continue
    }
    if (PACKAGE_MANAGER_NON_SCRIPT.has(lower)) return ""
    return token
  }
  return ""
}

const PACKAGE_MANAGERS = new Set([
  "npm", "npm.cmd",
  "pnpm", "pnpm.cmd",
  "yarn", "yarn.cmd",
  "bun", "bun.exe", "bun.cmd",
])

function packageManagerVerificationFamily(command) {
  for (const words of executableSegments(command)) {
    const word = executableName(words)
    if (!PACKAGE_MANAGERS.has(word)) continue
    const token = packageManagerScript(words)
    const match = token.match(VERIFY_SCRIPT)
    if (!match) continue
    const script = String(match[0] || token).split(":")[0].toLowerCase()
    if (script === "test") return "test"
    if (script === "lint" || script === "typecheck") return "diagnostics"
    if (script === "build") return "build"
    return "verification"
  }
  return null
}

function packageManagerLongRunningService(command) {
  for (const words of executableSegments(command)) {
    const word = executableName(words)
    if (!PACKAGE_MANAGERS.has(word)) continue
    const token = packageManagerScript(words).toLowerCase()
    if (/^(?:dev|start|serve|preview|watch)(?::|$)/i.test(token)) return true
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

const HIDES_PROGRESS = /(?:\||\|&)\s*(?:tail|head|grep|rg|sed|awk|findstr|select-string)\b|(?:>|>>)\s*[^&]/i

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
  const hidesProgress = shellAnalysisCommands(raw).some((candidate) => hidesProgressPipeline(candidate))
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
