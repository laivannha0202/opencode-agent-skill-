// Deterministic TypeScript/JavaScript diagnostics fallback (tier B).
//
// The managed LSP path (tier A) is a *push* model: the server publishes
// textDocument/dublishDiagnostics after a document sync and we wait for it. That
// is the cheap path and stays the default. It is not, however, a completeness
// guarantee: a server can be perfectly healthy (transport ok, session READY,
// reusable for symbols) and still never publish inside the budget.
//
// This module is the deterministic answer for the TypeScript/JavaScript case. It
// runs the *same* TypeScript compiler the language server already depends on --
// resolved from the provider's own installation, so there is no new dependency,
// no network access, and no version skew between the two paths.
//
// Two rules govern everything here:
//
//   1. A result is only reported `complete` when the compiler actually finished
//      evaluating the requested scope AND the evidence needed to trust that
//      scope was present. A workspace whose dependency graph does not resolve
//      cannot be proven free of type errors, so it reports `complete: false`
//      with the real diagnostics it did find. It never reports an empty list as
//      "clean" on incomplete evidence.
//   2. Nothing here writes. The compiler runs with `noEmit`, the host is a read
//      view, and no temporary artifact is produced on disk.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { runSupervisedProcess } from "../process-supervisor.mjs"

// NOTE: this module must never statically import "typescript". The runtime
// ships no TypeScript dependency of its own, so a top-level import would throw
// at module load and take the whole code-intelligence path down. The compiler
// is resolved lazily from the language server's own installation instead.

const DEFAULT_MAX_RESULTS = 120
const MAX_CONFIG_WALK_DEPTH = 16
const CACHE_LIMIT = 32
const FINGERPRINT_VERSION = "ts-fallback-v1"

// Compiler options used when a workspace ships no tsconfig/jsconfig. They are a
// deliberate, documented default rather than a guess at project intent: the
// point is to evaluate the target file under NodeNext semantics, which is what
// this runtime's own sources use, and to keep the evaluation read-only.
//
// These are written in tsconfig's *string* form because that is what a config
// file contains. `normalizeCompilerOptions` maps them onto the compiler's enum
// values before they reach `createProgram`, which rejects raw strings.
const DEFAULT_COMPILER_OPTIONS = Object.freeze({
  noEmit: true,
  allowJs: true,
  // Overridden per target below. A JavaScript target is only meaningfully
  // checkable with checkJs on; leaving it off would let a JS file be reported
  // "complete and clean" on the strength of an evaluation that checked nothing.
  checkJs: false,
  skipLibCheck: true,
  strict: false,
  noImplicitAny: false,
  moduleResolution: "node10",
  module: "esnext",
  target: "es2022",
  jsx: "preserve",
  resolveJsonModule: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  experimentalDecorators: true,
  types: [],
})

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"])

// tsconfig spells these as strings; the compiler API wants enums. Anything the
// compiler does not recognise is dropped rather than passed through, because a
// bad enum value aborts program creation entirely.
function normalizeCompilerOptions(ts, options) {
  const out = { ...options }
  const maps = [
    ["module", ts.ModuleKind],
    ["moduleResolution", ts.ModuleResolutionKind],
    ["target", ts.ScriptTarget],
    ["jsx", ts.JsxEmit],
  ]
  for (const [key, enumObject] of maps) {
    const value = out[key]
    if (typeof value === "number") continue
    if (typeof value !== "string") {
      delete out[key]
      continue
    }
    const resolved = enumObject && enumObject[value]
    if (typeof resolved === "number") out[key] = resolved
    else delete out[key]
  }
  return out
}

// Diagnostics that describe the *environment* rather than the code under test.
// Their presence means the module graph or ambient type set is incomplete, so
// the absence of further type errors cannot be proven. They are still reported
// to the caller -- they are real, actionable findings -- they just do not count
// as evidence that the evaluation was complete.
const ENVIRONMENT_DIAGNOSTIC_CODES = new Set([
  2307, // Cannot find module 'x' or its corresponding type declarations.
  2318, // Cannot find global type 'Array'.
  2503, // Cannot find namespace 'x'.
  2580, // Cannot find name 'require'/'process'/'module' -- missing @types/node.
  2591, // Cannot find name 'x'. Do you need to install type definitions?
  2688, // Cannot find type definition file for 'x'.
  2792, // Cannot find module. Did you mean to set 'moduleResolution'?
  2793, // CommonJS module cannot be imported with ESM semantics.
  7016, // Could not find a declaration file for module (implicit any).
  2686, // 'x' refers to a UMD global, but the current file is a module.
  2304, // Cannot find name 'x'.  (ambient type set incomplete)
  2314, // Generic type requires arguments / unresolved generic source.
])

let cachedTs = null
const CACHE = new Map()

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function toPosix(value) {
  return String(value).replaceAll("\\", "/")
}

/**
 * Out-of-process variant of `computeTypeScriptDiagnostics`.
 *
 * Preferred by the LSP path: the language server shares this process's event
 * loop, so synchronous compiler work must not run inline. The child is hard
 * bounded, and every failure mode degrades to `complete: false` with a reason.
 */
export async function runTypeScriptDiagnostics(input = {}) {
  const startedAt = Date.now()
  const budgetMs = bounded(input.timeoutMs, 20_000, 500, 120_000)
  const runner = fileURLToPath(new URL("./ts-diagnostics-runner.mjs", import.meta.url))
  const payload = JSON.stringify({
    base: path.resolve(input.base || process.cwd()),
    file: path.resolve(input.file || ""),
    provider: input.provider || {},
    timeoutMs: budgetMs,
    maxResults: input.maxResults,
  })

  const result = await runSupervisedProcess(process.execPath, [runner, payload], {
    cwd: path.resolve(input.base || process.cwd()),
    hardTimeoutMs: budgetMs,
    idleTimeoutMs: budgetMs,
    stdoutLimit: 4 * 1024 * 1024,
    stderrLimit: 64 * 1024,
    // Deterministic cleanup: when tier A wins the race the caller aborts this
    // signal, which reaps the child instead of leaving it running.
    signal: input.signal,
  })

  const wallMs = Date.now() - startedAt
  if (result.stopReason === "aborted") {
    // The caller won the race and no longer needs this result.
    return {
      complete: false,
      reason: "fallback-aborted",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: wallMs,
      evidenceFingerprint: null,
      compilerVersion: null,
      environmentDiagnosticCount: 0,
      aborted: true,
      error: null,
    }
  }
  if (result.timedOut || result.stopReason === "hard-timeout" || result.stopReason === "idle-timeout") {
    return {
      complete: false,
      reason: "fallback-timeout",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: wallMs,
      evidenceFingerprint: null,
      compilerVersion: null,
      environmentDiagnosticCount: 0,
      error: `fallback exceeded its ${budgetMs}ms budget`,
    }
  }

  let parsed = null
  try {
    parsed = JSON.parse(String(result.stdout || "").trim())
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      complete: false,
      reason: "fallback-process-error",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: wallMs,
      evidenceFingerprint: null,
      compilerVersion: null,
      environmentDiagnosticCount: 0,
      error: String(result.stderr || "fallback produced no parsable result")
        .trim()
        .slice(0, 400),
    }
  }
  return { ...parsed, durationMs: parsed.durationMs ?? wallMs, processWallMs: wallMs }
}

export function isEnvironmentDiagnostic(code) {
  return ENVIRONMENT_DIAGNOSTIC_CODES.has(Number(code))
}

function candidateRequireBases(provider = {}) {
  // Resolve from the provider's own installation first: the language server and
  // the fallback then share one compiler instance/version on disk.
  // The provider's launch command is a bare name (`typescript-language-server`),
  // not a path, so the package directory has to be rediscovered: the shim lives
  // in a PATH prefix while the package lives in that prefix's `node_modules`, and
  // `npm link` layouts differ again. Probing several anchors and taking the
  // first that resolves is best-effort by design: a miss degrades the fallback
  // to "compiler unavailable" rather than failing the whole operation.
  const bases = []
  const command = provider.command ? String(provider.command) : null
  const packageName = command && !command.includes("/") && !command.includes("\\")
    ? command.replace(/\.(cmd|exe|bat|ps1)$/i, "")
    : "typescript-language-server"

  const dirs = []
  if (command && (command.includes("/") || command.includes("\\"))) {
    const dir = path.dirname(command)
    dirs.push(dir, path.join(dir, "node_modules"), path.dirname(dir))
  }
  // Walk PATH the way a shell would resolve the bare command.
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue
    dirs.push(entry, path.join(entry, "node_modules"))
  }
  for (const dir of dirs) {
    bases.push(
      path.join(dir, packageName, "lib", "cli.mjs"),
      path.join(dir, packageName, "lib", "server.js"),
      path.join(dir, packageName, "lib", "cli.js"),
      path.join(dir, "lib", "cli.mjs"),
    )
  }
  return [...new Set(bases)]
}

export function resolveTypeScript(provider = {}) {
  if (cachedTs && cachedTs.providerId === provider.id) return cachedTs
  const bases = candidateRequireBases(provider)
  for (const base of bases) {
    try {
      if (!existsSync(base)) continue
      const require = createRequire(base)
      const ts = require("typescript")
      if (!ts || typeof ts.createProgram !== "function") continue
      cachedTs = {
        providerId: provider.id || null,
        ts,
        version: String(ts.version || "unknown"),
        origin: "provider-install",
        anchor: toPosix(base),
      }
      return cachedTs
    } catch {
      // Try the next anchor; a missing compiler is reported, never thrown.
    }
  }
  // No compiler could be resolved from the provider installation. This is a
  // reported degradation, never a thrown error: the caller keeps the tier A
  // outcome and its honest `complete: false`.
  return null
}

export function resetTypeScriptFallbackCache() {
  CACHE.clear()
  cachedTs = null
}

export function findProjectConfig(base, file) {
  let dir = path.dirname(path.resolve(file))
  const stop = path.resolve(base)
  for (let depth = 0; depth < MAX_CONFIG_WALK_DEPTH; depth += 1) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) {
        try {
          const stat = statSync(candidate)
          if (stat.isFile()) return { path: candidate, name, bytes: stat.size }
        } catch {
          // Unreadable config: keep walking rather than failing the request.
        }
      }
    }
    if (dir === stop || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  return null
}

function readCompilerOptions(ts, config, base, targetFile) {
  // A JavaScript target is checked, not merely parsed. Otherwise a `.mjs`/`.js`
  // file would routinely come back "complete" with zero diagnostics purely
  // because nothing was actually analysed, which is a false-clean.
  const isJavaScript = JAVASCRIPT_EXTENSIONS.has(path.extname(String(targetFile || "")).toLowerCase())
  if (!config) {
    return {
      options: { ...DEFAULT_COMPILER_OPTIONS, checkJs: isJavaScript },
      configFingerprint: "none",
      checkJs: isJavaScript,
    }
  }
  const raw = readFileSync(config.path, "utf8")
  const parsed = ts.parseConfigFileTextToJson(config.name, raw)
  if (parsed?.error) {
    return {
      options: { ...DEFAULT_COMPILER_OPTIONS, checkJs: isJavaScript },
      configFingerprint: sha256(`unparsed:${raw}`),
      checkJs: isJavaScript,
    }
  }
  const converted = ts.parseJsonConfigFileContent(
    parsed.config || {},
    ts.sys,
    path.dirname(config.path),
    undefined,
    config.path,
  )
  // `noEmit` is forced regardless of what the project declares: this path is
  // read-only evidence gathering, never a build.
  const options = { ...converted.options, noEmit: true, skipLibCheck: true, allowJs: true, checkJs: isJavaScript }
  return {
    options,
    configFingerprint: sha256(`${config.name}:${raw}`),
    fileNames: Array.isArray(converted.fileNames) ? converted.fileNames : [],
    checkJs: isJavaScript,
  }
}

function sanitize(ts, diagnostic, file, base, maxResults) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
  let startLine = null
  let startColumn = null
  if (diagnostic.file && diagnostic.start != null) {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    startLine = pos.line + 1
    startColumn = pos.character + 1
  }
  const related = path.resolve(file)
  return {
    severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    code: diagnostic.code,
    message: message.slice(0, 2000),
    file: toPosix(path.relative(base, related)) || toPosix(related),
    line: startLine,
    column: startColumn,
    source: "typescript-compiler-api",
    environment: isEnvironmentDiagnostic(diagnostic.code),
  }
}

export function diagnosticsEvidenceFingerprint(input = {}) {
  return sha256(
    [
      FINGERPRINT_VERSION,
      input.tsVersion || "",
      input.configFingerprint || "none",
      toPosix(input.file || ""),
      input.sourceHash || "",
    ].join("|"),
  )
}

/**
 * Compute deterministic diagnostics for a single TypeScript/JavaScript file.
 *
 * Never throws for a project that cannot be analysed: an unresolvable compiler,
 * a broken tsconfig or an out-of-budget evaluation all degrade to
 * `complete: false` with an explicit reason.
 */
export function computeTypeScriptDiagnostics(input = {}) {
  const startedAt = Date.now()
  const base = path.resolve(input.base || process.cwd())
  const file = path.resolve(input.file || "")
  const budgetMs = bounded(input.timeoutMs, 20_000, 500, 120_000)
  const maxResults = bounded(input.maxResults, DEFAULT_MAX_RESULTS, 1, 500)

  let source = ""
  try {
    source = readFileSync(file, "utf8")
  } catch (error) {
    return {
      complete: false,
      reason: "fallback-unreadable-file",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: Date.now() - startedAt,
      evidenceFingerprint: null,
      compilerVersion: null,
      configPath: null,
      environmentDiagnosticCount: 0,
      error: String(error instanceof Error ? error.message : error).slice(0, 400),
    }
  }

  const resolved = resolveTypeScript(input.provider || {})
  if (!resolved) {
    return {
      complete: false,
      reason: "fallback-compiler-unavailable",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: Date.now() - startedAt,
      evidenceFingerprint: null,
      compilerVersion: null,
      configPath: null,
      environmentDiagnosticCount: 0,
      error: "typescript compiler could not be resolved",
    }
  }

  const ts = resolved.ts
  const config = findProjectConfig(base, file)
  const { options, configFingerprint } = readCompilerOptions(ts, config, base, file)
  const sourceHash = sha256(source)
  const evidenceFingerprint = diagnosticsEvidenceFingerprint({
    tsVersion: resolved.version,
    configFingerprint,
    file,
    sourceHash,
  })

  const cached = CACHE.get(evidenceFingerprint)
  if (cached) {
    // Rotate for bounded LRU without re-ordering cost on every miss.
    CACHE.delete(evidenceFingerprint)
    CACHE.set(evidenceFingerprint, cached)
    return { ...cached, cached: true, durationMs: Date.now() - startedAt }
  }

  let outcome
  try {
    // Read-only host: the default compiler host only reads, and `noEmit` is
    // forced above, so this can never produce an artifact.
    const host = ts.createCompilerHost(normalizeCompilerOptions(ts, options), true)
    const program = ts.createProgram({
      rootNames: [file],
      options: normalizeCompilerOptions(ts, options),
      host,
    })
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) {
      outcome = {
        complete: false,
        reason: "fallback-source-not-in-program",
        diagnostics: [],
        source: "typescript-compiler-api",
        durationMs: 0,
        evidenceFingerprint,
        compilerVersion: resolved.version,
        configPath: config ? toPosix(path.relative(base, config.path)) : null,
        environmentDiagnosticCount: 0,
        error: "target file was not part of the program",
      }
    } else {
      const syntactic = program.getSyntacticDiagnostics(sourceFile)
      const semantic = program.getSemanticDiagnostics(sourceFile)
      const all = [...syntactic, ...semantic]
      const diagnostics = all
        .slice(0, maxResults)
        .map((item) => sanitize(ts, item, file, base, maxResults))
      const environmentDiagnosticCount = all.filter((item) =>
        isEnvironmentDiagnostic(item.code),
      ).length
      const truncated = all.length > maxResults
      // Completion proof: the compiler ran to completion for this file AND the
      // evaluation was not silently degraded by an unresolved module graph or a
      // missing ambient type set. Either one means "absence of errors is
      // unproven", which must never be reported as clean.
      const environmentIncomplete = environmentDiagnosticCount > 0
      const overBudget = Date.now() - startedAt > budgetMs
      let reason = "ok"
      if (overBudget) reason = "fallback-timeout"
      else if (environmentIncomplete) reason = "fallback-environment-incomplete"
      else if (truncated) reason = "fallback-truncated"
      outcome = {
        complete: reason === "ok",
        reason,
        diagnostics,
        source: "typescript-compiler-api",
        durationMs: Date.now() - startedAt,
        evidenceFingerprint,
        compilerVersion: resolved.version,
        configPath: config ? toPosix(path.relative(base, config.path)) : null,
        environmentDiagnosticCount,
        totalDiagnosticCount: all.length,
        truncated,
        error: null,
      }
    }
  } catch (error) {
    outcome = {
      complete: false,
      reason: "fallback-error",
      diagnostics: [],
      source: "typescript-compiler-api",
      durationMs: Date.now() - startedAt,
      evidenceFingerprint,
      compilerVersion: resolved.version,
      configPath: config ? toPosix(path.relative(base, config.path)) : null,
      environmentDiagnosticCount: 0,
      error: String(error instanceof Error ? error.message : error).slice(0, 400),
    }
  }

  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest) CACHE.delete(oldest)
  }
  const stored = { ...outcome, cached: false }
  CACHE.set(evidenceFingerprint, stored)
  return stored
}
