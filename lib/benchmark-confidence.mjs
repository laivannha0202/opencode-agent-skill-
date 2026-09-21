function asBool(value) {
  return value === true
}

function pairKey(item) {
  return [item.suite || "", item.task || "", item.trial || 1].join("::")
}

function exactSignPValue(a, b) {
  const n = a + b
  if (n <= 0) return 1
  const k = Math.min(a, b)
  let probability = 2 ** (-n)
  let cumulative = probability
  for (let i = 1; i <= k; i += 1) {
    probability *= (n - i + 1) / i
    cumulative += probability
  }
  return Math.min(1, cumulative * 2)
}

function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value))
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null
}

export function pairedBenchmarkConfidence(results, options = {}) {
  const byKey = new Map()
  for (const item of results || []) {
    if (!["baseline", "ues"].includes(item?.mode)) continue
    const key = pairKey(item)
    const pair = byKey.get(key) || {}
    pair[item.mode] = item
    byKey.set(key, pair)
  }
  const pairs = [...byKey.entries()]
    .filter(([, pair]) => pair.baseline && pair.ues)
    .map(([key, pair]) => ({ key, ...pair }))

  let bothPass = 0
  let bothFail = 0
  let baselineOnly = 0
  let uesOnly = 0
  for (const pair of pairs) {
    const b = asBool(pair.baseline.passed)
    const u = asBool(pair.ues.passed)
    if (b && u) bothPass += 1
    else if (!b && !u) bothFail += 1
    else if (b) baselineOnly += 1
    else uesOnly += 1
  }
  const total = pairs.length
  const baselinePassed = bothPass + baselineOnly
  const uesPassed = bothPass + uesOnly
  const baselinePassRate = total ? baselinePassed / total : 0
  const uesPassRate = total ? uesPassed / total : 0
  const delta = uesPassRate - baselinePassRate
  const pValue = exactSignPValue(uesOnly, baselineOnly)

  const suites = {}
  for (const pair of pairs) {
    const suite = pair.baseline.suite || pair.ues.suite || "unknown"
    suites[suite] ??= { total: 0, baselinePassed: 0, uesPassed: 0 }
    suites[suite].total += 1
    if (pair.baseline.passed) suites[suite].baselinePassed += 1
    if (pair.ues.passed) suites[suite].uesPassed += 1
  }
  for (const item of Object.values(suites)) {
    item.baselinePassRate = item.total ? item.baselinePassed / item.total : 0
    item.uesPassRate = item.total ? item.uesPassed / item.total : 0
    item.delta = item.uesPassRate - item.baselinePassRate
  }

  const baselineDurations = pairs.map((pair) => Number(pair.baseline.durationMs))
  const uesDurations = pairs.map((pair) => Number(pair.ues.durationMs))
  const baselineDuration = mean(baselineDurations)
  const uesDuration = mean(uesDurations)
  const durationRatio = baselineDuration && uesDuration ? uesDuration / baselineDuration : null

  const baselineCosts = pairs.map((pair) => Number(pair.baseline.telemetry?.cost)).filter((value) => value > 0)
  const uesCosts = pairs.map((pair) => Number(pair.ues.telemetry?.cost)).filter((value) => value > 0)
  const baselineCost = mean(baselineCosts)
  const uesCost = mean(uesCosts)
  const costRatio = baselineCost && uesCost ? uesCost / baselineCost : null

  const minPairs = Math.max(1, Number(options.minPairs || 20))
  const alpha = Math.min(0.5, Math.max(0.0001, Number(options.alpha || 0.05)))
  const minDelta = Math.max(0, Number(options.minDelta || 0))
  const suiteRegressionTolerance = Math.max(0, Number(options.suiteRegressionTolerance || 0))
  const maxDurationRatio = Math.max(1, Number(options.maxDurationRatio || 1.75))
  const noSuiteRegression = Object.values(suites).every((item) => item.delta >= -suiteRegressionTolerance)
  const speedAcceptable = durationRatio == null || durationRatio <= maxDurationRatio

  const checks = {
    pairedCoverage: total >= minPairs,
    positiveDelta: delta > minDelta,
    moreWinsThanLosses: uesOnly > baselineOnly,
    statisticallySupported: pValue <= alpha,
    noSuiteRegression,
    speedAcceptable,
  }
  return {
    schemaVersion: 1,
    kind: "ues-paired-benchmark-confidence",
    pairs: total,
    bothPass,
    bothFail,
    baselineOnly,
    uesOnly,
    baselinePassed,
    uesPassed,
    baselinePassRate,
    uesPassRate,
    delta,
    pValue,
    alpha,
    minPairs,
    minDelta,
    suiteRegressionTolerance,
    duration: {
      baselineMeanMs: baselineDuration,
      uesMeanMs: uesDuration,
      ratio: durationRatio,
      maxRatio: maxDurationRatio,
    },
    cost: {
      baselineMean: baselineCost,
      uesMean: uesCost,
      ratio: costRatio,
    },
    suites,
    checks,
    promotionEligible: Object.values(checks).every(Boolean),
  }
}
