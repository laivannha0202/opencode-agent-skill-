import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { analyzeShellCommand, boundedVerificationTimeout } from "../lib/command-intelligence.mjs"
import { cacheStabilityFromRows } from "../lib/provider-cache-stability.mjs"
import { modelRuntimeProfile } from "../lib/model-runtime-profile.mjs"
import { pairedBenchmarkConfidence } from "../lib/benchmark-confidence.mjs"
import { buildTaskTelemetry } from "../lib/run-telemetry.mjs"

test("V15.8 command intelligence unwraps Windows and POSIX shell wrappers", () => {
  const cases = [
    ['& "C:\\Program Files\\nodejs\\npm.cmd" test', "test", false],
    ['& "C:\\Program Files\\nodejs\\npm.cmd" run dev', null, true],
    ["cmd /c npm test", "test", false],
    ["cmd /c npm run dev", null, true],
    ['cmd.exe /d /s /c "pnpm --filter web test"', "test", false],
    ['powershell -NoProfile -Command "npm test"', "test", false],
    ['powershell -NoProfile -Command "npm run dev"', null, true],
    ['pwsh -Command "pnpm --filter web dev"', null, true],
    ['bash -lc "npm test"', "test", false],
  ]
  for (const [command, family, service] of cases) {
    const analysis = analyzeShellCommand(command)
    assert.equal(analysis.verificationFamily, family, command)
    assert.equal(analysis.shouldUseManagedService, service, command)
  }
})

test("V15.8 command intelligence detects hidden verification output inside wrappers", () => {
  for (const command of [
    'powershell -Command "npm test | tail -20"',
    'cmd /c "npm test | findstr FAIL"',
    'pwsh -Command "pnpm test | Select-String FAIL"',
  ]) {
    const analysis = analyzeShellCommand(command, { verificationTimeoutSec: 300 })
    assert.equal(analysis.verificationLike, true, command)
    assert.equal(analysis.hidesProgress, true, command)
    assert.equal(analysis.finding, "verification-output-hidden-by-pipeline", command)
    assert.equal(boundedVerificationTimeout(analysis, 5400, 300), 300, command)
  }
})

test("V15.8 command intelligence supports Bun verification and services", () => {
  assert.equal(analyzeShellCommand("bun test").verificationFamily, "test")
  assert.equal(analyzeShellCommand("bun --filter web test").verificationFamily, "test")
  assert.equal(analyzeShellCommand("bun run dev").shouldUseManagedService, true)
  assert.equal(analyzeShellCommand("bun --filter web run start").shouldUseManagedService, true)
})

function cacheRow(provider, inputTokens, cacheReadTokens, cacheWriteTokens = 0) {
  return {
    type: "task.telemetry",
    provider,
    model: "same/model",
    metrics: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      usageAccounting: "pi-normalized-disjoint",
    },
  }
}

test("V15.8 cache learning is provider scoped", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => cacheRow("provider-a", 100, 900)),
    ...Array.from({ length: 6 }, () => cacheRow("provider-b", 1000, 0)),
  ]
  const providerA = cacheStabilityFromRows(rows, {
    provider: "provider-a",
    model: "same/model",
    minSamples: 6,
    stableSamples: 6,
  })
  const providerB = cacheStabilityFromRows(rows, {
    provider: "provider-b",
    model: "same/model",
    minSamples: 6,
    stableSamples: 6,
  })
  assert.equal(providerA.mode, "cache")
  assert.equal(providerA.cacheReadRatio, 0.9)
  assert.equal(providerB.mode, "token")
  assert.equal(providerB.cacheReadRatio, 0)
})

test("V15.8 cache learning rejects legacy or incompatible accounting schemas", () => {
  const compatible = Array.from({ length: 6 }, () => cacheRow("provider-a", 1000, 0))
  const legacy = Array.from({ length: 6 }, () => {
    const row = cacheRow("provider-a", 100, 900)
    delete row.metrics.usageAccounting
    return row
  })
  const incompatible = Array.from({ length: 6 }, () => ({
    ...cacheRow("provider-a", 100, 900),
    metrics: {
      ...cacheRow("provider-a", 100, 900).metrics,
      usageAccounting: "legacy-overlapping-cache",
    },
  }))
  const policy = cacheStabilityFromRows([...compatible, ...legacy, ...incompatible], {
    provider: "provider-a",
    model: "same/model",
    minSamples: 6,
    stableSamples: 6,
    usageAccounting: "pi-normalized-disjoint",
  })
  assert.equal(policy.samples, 6)
  assert.equal(policy.cacheReadRatio, 0)
  assert.equal(policy.mode, "token")
})

test("V15.8 cache policy uses bounded hysteresis after measured evidence", () => {
  const rows = Array.from({ length: 6 }, () => cacheRow("provider-a", 650, 350))
  const cold = cacheStabilityFromRows(rows, {
    provider: "provider-a",
    model: "same/model",
    minSamples: 6,
    stableSamples: 12,
  })
  const retained = cacheStabilityFromRows(rows, {
    provider: "provider-a",
    model: "same/model",
    minSamples: 6,
    stableSamples: 12,
    previousMode: "cache",
  })
  assert.equal(cold.mode, "balanced")
  assert.equal(retained.mode, "cache")
  assert.equal(retained.reason, "measured-cache-hysteresis")
})

test("V15.8 model runtime profile prefers measured and configured evidence over names", () => {
  const configured = modelRuntimeProfile("provider/super-flash", {
    capabilityProfile: {
      quality: 0.95,
      reasoning: true,
      toolCalling: true,
    },
  })
  assert.equal(configured.surface, "expanded")
  assert.equal(configured.evidenceSource, "CONFIGURED")

  const measuredWeak = modelRuntimeProfile("provider/gpt-6", {
    capabilityProfile: {
      quality: 0.95,
      reasoning: true,
      toolCalling: true,
    },
    performanceRecord: {
      samples: 12,
      passRate: 0.5,
      avgRetries: 2,
    },
    performanceMinSamples: 8,
  })
  assert.equal(measuredWeak.surface, "compact")
  assert.equal(measuredWeak.evidenceSource, "MEASURED")

  const heuristic = modelRuntimeProfile("provider/tiny-flash", {})
  assert.equal(heuristic.surface, "compact")
  assert.equal(heuristic.evidenceSource, "HEURISTIC")
})

function promotionPairs(withUsage) {
  const rows = []
  for (let index = 0; index < 20; index += 1) {
    const baselineTelemetry = withUsage
      ? { firstUsage: { input: 1200 }, tokens: { total: 2400 } }
      : {}
    const uesTelemetry = withUsage
      ? { controllerUsed: true, controllerPass: true, firstUsage: { input: 900 }, tokens: { total: 1800 } }
      : { controllerUsed: true, controllerPass: true }
    rows.push(
      {
        suite: "live",
        task: "promotion-" + index,
        trial: 1,
        mode: "baseline",
        passed: true,
        baselineIsolated: true,
        graderExit: 0,
        durationMs: 200,
        telemetry: baselineTelemetry,
      },
      {
        suite: "live",
        task: "promotion-" + index,
        trial: 1,
        mode: "ues",
        passed: true,
        graderExit: 0,
        durationMs: 120,
        telemetry: uesTelemetry,
      },
    )
  }
  return rows
}

test("V15.8 telemetry keys learning by routed model identity", () => {
  const row = buildTaskTelemetry(
    {
      model: "provider-display-model",
      exitCode: 0,
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 },
    },
    {
      model: "provider-a/canonical-model",
      provider: "provider-a",
      task: "identity test",
    },
  )
  assert.equal(row.model, "provider-a/canonical-model")
  assert.equal(row.provider, "provider-a")
  assert.equal(row.metrics.usageAccounting, "pi-normalized-disjoint")
})

test("V15.8 real-model promotion fails closed when efficiency telemetry is absent", () => {
  const missing = pairedBenchmarkConfidence(promotionPairs(false), {
    requireMeasuredEfficiency: true,
  })
  assert.equal(missing.telemetryEvidence.required, true)
  assert.equal(missing.telemetryEvidence.initialInputMeasured, false)
  assert.equal(missing.telemetryEvidence.tokensMeasured, false)
  assert.equal(missing.turbo.promotionEligible, false)

  const measured = pairedBenchmarkConfidence(promotionPairs(true), {
    requireMeasuredEfficiency: true,
  })
  assert.equal(measured.telemetryEvidence.initialInputMeasured, true)
  assert.equal(measured.telemetryEvidence.tokensMeasured, true)
  assert.equal(measured.turbo.promotionEligible, true)
})

test("V15.8 Pi eval captures first usage and exposes a hard promotion switch", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const source = await readFile(path.join(root, "scripts", "eval-pi.mjs"), "utf8")
  const extensionSource = await readFile(path.join(root, "pi", "extensions", "ues.ts"), "utf8")
  assert.match(extensionSource, /const telemetryRoot = await taskSandboxOwnerRoot\(cwd\).*\|\| traceRoot/)
  assert.match(extensionSource, /providerCacheStabilityPolicy\(telemetryRoot, \{/)
  assert.match(extensionSource, /const artifactRoot = telemetryRoot/)
  assert.match(extensionSource, /firstUsage\?: any/)
  assert.match(extensionSource, /if \(firstUsage === undefined && event\.message\.usage\) firstUsage = event\.message\.usage/)
  assert.match(extensionSource, /firstUsage: firstUsage \|\| message\?\.usage/)
  assert.match(extensionSource, /firstUsage: result\.firstUsage \|\| resumed\.firstUsage/)
  assert.match(extensionSource, /provider: selectedProvider,\s*model: selectedModel/)
  assert.match(extensionSource, /const performanceModel = result\.modelSelection\?\.model \|\| result\.model/)
  assert.match(source, /const telemetryLines = \[\]/)
  assert.match(source, /telemetryLines\.push\(line\)/)
  assert.match(source, /parsePiTelemetry\(telemetryLines\.join\("\\n"\)\)/)
  assert.doesNotMatch(source, /\[agentRun\.stdout, agentRun\.stderr\]/)
  assert.match(source, /usageSample\(step\.firstUsage \|\| step\.usage\)/)
  assert.match(source, /if \(firstUsage === null\) firstUsage = usageSample/)
  assert.match(source, /requireMeasuredEfficiency: true/)
  assert.match(source, /--require-promotion/)
  assert.match(source, /UES real-model promotion gate: PASS/)
})
