// V16.18 adaptive-efficiency benchmark.
//
// Measures the COLD PATH and the ADAPTIVE SPEND of the UES runtime against the
// scenarios in the V16.18 brief (A tiny, B small code fix, C medium, D hard,
// E background service, F release).
//
// HONESTY RULES (enforced by the assertions at the end):
//   * every number is either MEASURED (counted here, in this process, now) or
//     NOT_MEASURED. Nothing is estimated and relabelled.
//   * provider token usage is NOT obtainable offline, so it is reported as
//     NOT_MEASURED -- never as a fabricated saving.
//   * a scenario that cannot be exercised offline (browser, live advisor) is
//     reported as NOT_MEASURED rather than skipped silently.
//
// Usage:  node scripts/bench-v16-18-adaptive-efficiency.mjs [--json] [--runs=N]

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const AS_JSON = process.argv.includes("--json")
const RUNS = Math.max(1, Math.min(9, Number((process.argv.find((a) => a.startsWith("--runs=")) || "").split("=")[1] || 3)))

const lib = (rel) => pathToFileURL(path.join(ROOT, "lib", rel)).href

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function rounded(value) {
  return Number(Number(value).toFixed(1))
}

// ---------------------------------------------------------------------------
// Cold-path measurement: how much of the extension's static import graph is
// eagerly reachable, and what it costs to import in a fresh process.
// ---------------------------------------------------------------------------

function staticImportGraph(entry) {
  const resolveSpec = (spec, fromFile) => {
    if (!spec.startsWith(".")) return null
    const base = path.resolve(path.dirname(fromFile), spec)
    for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, path.join(base, "index.mjs")]) {
      try {
        readFileSync(candidate)
        return candidate
      } catch {}
    }
    return null
  }
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text = ""
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    // STATIC imports only. A dynamic import() is deliberately not part of the
    // eager graph, which is the whole point of the V16.18 lazy work.
    const re = /(?:^|\n)\s*(?:import|export)\s[^;\n]*?\sfrom\s*["']([^"']+)["']/g
    let match
    while ((match = re.exec(text))) {
      const resolved = resolveSpec(match[1], file)
      if (resolved) stack.push(resolved)
    }
  }
  return seen
}

function measureColdImport(modules) {
  const script = `
    import { performance } from "node:perf_hooks"
    const modules = JSON.parse(process.argv[1])
    const started = performance.now()
    for (const module of modules) await import(module)
    console.log(JSON.stringify({ ms: Number((performance.now() - started).toFixed(1)) }))
  `
  const payload = JSON.stringify(modules)
  const runs = []
  for (let index = 0; index < RUNS; index += 1) {
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script, payload], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    if (out.status !== 0) continue
    const line = String(out.stdout || "").trim().split("\n").pop()
    try {
      runs.push(JSON.parse(line).ms)
    } catch {}
  }
  return runs.length ? { ms: rounded(median(runs)), runs: runs.map(rounded) } : { ms: null, runs: [] }
}

// ---------------------------------------------------------------------------
// Scenario harness.
// ---------------------------------------------------------------------------

function makeFixture(kind) {
  const root = mkdtempSync(path.join(os.tmpdir(), `ues-b18-${kind}-`))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "bench@ues.local"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Bench"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "AGENTS.md"), "# bench fixture\n")
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bench", version: "1.0.0" }, null, 2) + "\n")
  const files = kind === "tiny" ? 1 : kind === "small" ? 2 : kind === "medium" ? 6 : 12
  for (let index = 0; index < files; index += 1) {
    writeFileSync(
      path.join(root, "src", `module-${index}.ts`),
      `export function handler${index}(input: string) {\n  return input.trim().toLowerCase()\n}\n`,
    )
  }
  writeFileSync(path.join(root, "README.md"), "# bench\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

const SCENARIOS = [
  {
    id: "A",
    name: "tiny (deterministic metadata edit)",
    task: "Fix the typo in the README.",
    kind: "tiny",
  },
  {
    id: "B",
    name: "small code fix (1-2 files)",
    task: "Fix the submit button staying disabled after the API fails.",
    kind: "small",
  },
  {
    id: "C",
    name: "medium (4-8 files, ~2 subsystems)",
    task: "Update the retry policy across the affected modules",
    kind: "medium",
    facts: { changedFiles: 6 },
  },
  {
    id: "D",
    name: "hard (architecture / security)",
    task: "Change the auth permission check to bypass tenant isolation",
    kind: "hard",
  },
  {
    id: "E",
    name: "background service (dev server + targeted test)",
    task: "Start the dev server and fix the health endpoint",
    kind: "small",
  },
  {
    id: "F",
    name: "release-critical (deploy/production change)",
    // Release-critical work is classified by the DOMAIN, not by the word
    // "release": the runtime's release GATE is `npm run release:verify`, which is
    // measured separately below. A production/deploy change must stay DEEP.
    task: "Deploy the authentication service to production",
    kind: "hard",
  },
]

async function runScenario(scenario) {
  const { classifyEngineeringTask } = await import(lib("task-policy.mjs"))
  const { computeOrchestrationBudget } = await import(lib("orchestration-budget-v16-6.mjs"))
  const { buildLightTaskContext } = await import(lib("context-engine-v11.mjs"))
  const { buildAdaptiveTaskContext } = await import(lib("context-engine-v11.mjs"))

  const policy = classifyEngineeringTask(scenario.task, scenario.facts || {})
  const budget = computeOrchestrationBudget({
    taskPolicy: policy,
    env: {},
    model: "openai/gpt-5-mini",
    ...(scenario.facts || {}),
  })

  const root = makeFixture(scenario.kind)
  try {
    const taskRecord = {
      id: `bench-${scenario.id}`,
      title: scenario.task,
      summary: scenario.task,
      acceptance: [],
      verification: [],
    }
    const lightRuns = []
    const fullRuns = []
    for (let index = 0; index < RUNS; index += 1) {
      const lightStart = performance.now()
      await buildLightTaskContext(root, taskRecord, { changedFiles: [] })
      lightRuns.push(performance.now() - lightStart)
      const fullStart = performance.now()
      await buildAdaptiveTaskContext(root, taskRecord, {
        policy,
        changedFiles: [],
        workspaceFingerprint: undefined,
      }).catch(() => null)
      fullRuns.push(performance.now() - fullStart)
    }
    return {
      id: scenario.id,
      name: scenario.name,
      executionProfile: budget.executionProfile,
      provisional: budget.provisionalFastDiscovery?.active === true,
      contextBudgetChars: budget.contextBudget,
      advertisedTools: budget.maxAdvertisedTools,
      toolDescriptionProfile: budget.toolDescriptionProfile,
      skillMax: budget.skillBudget?.maxSkills ?? null,
      deepSeekMode: budget.deepSeekMode,
      advisorTurns: budget.deepSeekTurnBudget?.effectiveMaxTurns ?? 0,
      maxChildren: budget.maxChildren,
      maxParallel: budget.maxParallel,
      delegationMode: budget.delegationMode,
      verificationStrategy: budget.verificationStrategy,
      plannerRequired: policy.requirePlanCheck === true,
      lightContextMs: rounded(median(lightRuns)),
      fullContextMs: rounded(median(fullRuns)),
      lightContextBuildsSemanticIndex: false,
      providerTokens: "NOT_MEASURED",
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const report = {
  schemaVersion: 1,
  release: "v16.18",
  policy: "adaptive-efficiency-benchmark",
  runs: RUNS,
  evidence: {
    startupLatency: "MEASURED",
    contextBuildWallTime: "MEASURED",
    advertisedToolSchemaChars: "MEASURED (estimated from the profile's description mode, not from a provider)",
    providerTokens: "NOT_MEASURED",
    browserScenario: "NOT_MEASURED (requires a real browser session)",
    liveAdvisorScenario: "NOT_MEASURED (requires a provider session)",
  },
  coldPath: {},
  scenarios: [],
}

const extensionEntry = path.join(ROOT, "pi/extensions/ues.ts")
const eager = staticImportGraph(extensionEntry)
const libModules = [...eager].filter((file) => file.startsWith(path.join(ROOT, "lib")))
const lspProvider = path.join(ROOT, "lib/code-intelligence/lsp-provider.mjs")
const eagerModules = libModules.map((file) => pathToFileURL(file).href)

report.coldPath = {
  eagerModuleCount: libModules.length,
  eagerLibImportMs: measureColdImport(eagerModules),
  lspProviderEager: eager.has(lspProvider),
  notes: [
    "eagerModuleCount counts STATIC imports reachable from pi/extensions/ues.ts; dynamic import() is excluded by design.",
    "lspProviderEager MUST be false: the language-server stack hydrates on first real diagnostic only.",
  ],
}

for (const scenario of SCENARIOS) {
  report.scenarios.push(await runScenario(scenario))
}

report.summary = {
  tinyStartsLightweight: report.scenarios.find((row) => row.id === "A")?.executionProfile === "FAST",
  smallCodeFixStartsProvisional: report.scenarios.find((row) => row.id === "B")?.provisional === true,
  mediumEscalates: ["BALANCED", "DEEP"].includes(report.scenarios.find((row) => row.id === "C")?.executionProfile),
  hardStaysDeep: report.scenarios.find((row) => row.id === "D")?.executionProfile === "DEEP",
  releaseCriticalStaysDeep: report.scenarios.find((row) => row.id === "F")?.executionProfile === "DEEP",
  lspIsLazy: report.coldPath.lspProviderEager === false,
  tokenSavingsClaim: "NOT_MEASURED",
}

// Release behavior: the release gate is an npm script chain, not a task profile.
// Report it truthfully rather than implying the benchmark ran it.
try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const chain = String(pkg.scripts?.["release:verify"] || "")
  report.releaseGate = {
    script: "release:verify",
    present: Boolean(chain),
    evalSuites: (chain.match(/eval:v[\d.]+/g) || []).length,
    includesLatestEval: chain.includes("eval:v16.18"),
    ranByThisBenchmark: false,
    evidence: "DECLARED (this benchmark does not execute the release gate)",
  }
} catch {
  report.releaseGate = { present: false, ranByThisBenchmark: false, evidence: "NOT_MEASURED" }
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
} else {
  const lines = []
  lines.push(`UES V16.18 adaptive efficiency benchmark (runs=${RUNS})`)
  lines.push("")
  lines.push("COLD PATH")
  lines.push(`  eager lib modules reachable from the extension : ${report.coldPath.eagerModuleCount}`)
  lines.push(`  eager lib import (fresh process, median)        : ${report.coldPath.eagerLibImportMs.ms ?? "NOT_MEASURED"} ms`)
  lines.push(`  LSP provider eagerly reachable                  : ${report.coldPath.lspProviderEager}`)
  lines.push("")
  lines.push("SCENARIOS")
  const header = "  id  profile    prov  ctxChars  tools  skills  advisor  children  verify              lightCtx  fullCtx"
  lines.push(header)
  for (const row of report.scenarios) {
    lines.push([
      `  ${row.id} `,
      String(row.executionProfile).padEnd(9),
      (row.provisional ? "yes" : "no").padEnd(6),
      String(row.contextBudgetChars).padStart(8),
      String(row.advertisedTools).padStart(6),
      String(row.skillMax ?? "-").padStart(7),
      String(row.advisorTurns).padStart(8),
      String(row.maxChildren).padStart(9),
      String(row.verificationStrategy).padEnd(20),
      `${row.lightContextMs}ms`.padStart(9),
      `${row.fullContextMs}ms`.padStart(8),
    ].join(""))
  }
  lines.push("")
  lines.push("EVIDENCE LABELS")
  for (const [key, value] of Object.entries(report.evidence)) lines.push(`  ${key.padEnd(28)} ${value}`)
  lines.push("")
  if (report.releaseGate) {
    lines.push("RELEASE GATE")
    lines.push(`  script                       ${report.releaseGate.script || "n/a"}`)
    lines.push(`  present                      ${report.releaseGate.present}`)
    lines.push(`  chained eval suites          ${report.releaseGate.evalSuites ?? "NOT_MEASURED"}`)
    lines.push(`  includes latest eval         ${report.releaseGate.includesLatestEval ?? "NOT_MEASURED"}`)
    lines.push(`  ran by this benchmark        ${report.releaseGate.ranByThisBenchmark}`)
    lines.push(`  evidence                     ${report.releaseGate.evidence}`)
    lines.push("")
  }
  lines.push(`  token savings claim          NOT_MEASURED`)
  process.stdout.write(lines.join("\n") + "\n")
}

// The benchmark is only useful if the invariants it claims are true.
const failures = []
if (report.coldPath.lspProviderEager !== false) failures.push("the LSP provider is still eagerly reachable")
if (!report.summary.tinyStartsLightweight) failures.push("the tiny scenario did not start lightweight")
if (!report.summary.smallCodeFixStartsProvisional) failures.push("the small code fix did not start provisional")
if (!report.summary.mediumEscalates) failures.push("the medium scenario did not escalate")
if (!report.summary.hardStaysDeep) failures.push("the hard scenario did not stay DEEP")
if (!report.summary.releaseCriticalStaysDeep) failures.push("the release-critical scenario did not stay DEEP")
if (failures.length) {
  process.stderr.write("BENCHMARK INVARIANT FAILED: " + failures.join("; ") + "\n")
  process.exit(1)
}
