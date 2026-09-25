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

function positiveMean(values) {
  return mean(values.map(Number).filter((value) => Number.isFinite(value) && value > 0))
}

function ratio(candidate, reference) {
  return reference && candidate ? candidate / reference : null
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

  const baselineDuration = mean(pairs.map((pair) => Number(pair.baseline.durationMs)))
  const uesDuration = mean(pairs.map((pair) => Number(pair.ues.durationMs)))
  const durationRatio = ratio(uesDuration, baselineDuration)

  const baselineCost = positiveMean(pairs.map((pair) => pair.baseline.telemetry?.cost))
  const uesCost = positiveMean(pairs.map((pair) => pair.ues.telemetry?.cost))
  const costRatio = ratio(uesCost, baselineCost)

  const baselineInitialInput = positiveMean(
    pairs.map((pair) => pair.baseline.telemetry?.firstUsage?.input),
  )
  const uesInitialInput = positiveMean(
    pairs.map((pair) => pair.ues.telemetry?.firstUsage?.input),
  )
  const initialInputRatio = ratio(uesInitialInput, baselineInitialInput)

  const baselineTokens = positiveMean(
    pairs.map((pair) => pair.baseline.telemetry?.tokens?.total),
  )
  const uesTokens = positiveMean(
    pairs.map((pair) => pair.ues.telemetry?.tokens?.total),
  )
  const tokenRatio = ratio(uesTokens, baselineTokens)

  const minPairs = Math.max(1, Number(options.minPairs || 20))
  const alpha = Math.min(0.5, Math.max(0.0001, Number(options.alpha || 0.05)))
  const minDelta = Math.max(0, Number(options.minDelta || 0))
  const suiteRegressionTolerance = Math.max(0, Number(options.suiteRegressionTolerance || 0))
  const maxDurationRatio = Math.max(1, Number(options.maxDurationRatio || 1.75))
  const maxInitialInputRatio = Math.max(1, Number(options.maxInitialInputRatio || 1.5))
  const maxTokenRatio = Math.max(1, Number(options.maxTokenRatio || 1.75))
  const noSuiteRegression = Object.values(suites).every((item) => item.delta >= -suiteRegressionTolerance)
  const speedAcceptable = durationRatio == null || durationRatio <= maxDurationRatio
  const initialInputAcceptable = initialInputRatio == null || initialInputRatio <= maxInitialInputRatio
  const tokensAcceptable = tokenRatio == null || tokenRatio <= maxTokenRatio

  const checks = {
    pairedCoverage: total >= minPairs,
    positiveDelta: delta > minDelta,
    moreWinsThanLosses: uesOnly > baselineOnly,
    statisticallySupported: pValue <= alpha,
    noSuiteRegression,
    speedAcceptable,
    initialInputAcceptable,
    tokensAcceptable,
  }

  const baselineContaminated = pairs.filter((pair) => pair.baseline?.baselineIsolated === false).length
  const baselineIsolationUnknown = pairs.filter((pair) => pair.baseline?.baselineIsolated !== true).length - baselineContaminated
  const uesControllerUnproven = pairs.filter((pair) => pair.ues?.telemetry?.controllerUsed !== true).length
  const uesFalsePasses = pairs.filter((pair) =>
    pair.ues?.telemetry?.controllerPass === true &&
    Number(pair.ues?.graderExit) !== 0
  ).length
  const qualityRegressionTolerance = Math.max(0, Number(options.qualityRegressionTolerance || 0))
  const qualityNonRegression = delta >= -qualityRegressionTolerance
  const efficiencySignals = [
    durationRatio == null ? null : durationRatio < 1,
    initialInputRatio == null ? null : initialInputRatio < 1,
    tokenRatio == null ? null : tokenRatio < 1,
  ].filter((value) => value !== null)
  const efficiencyImproved = efficiencySignals.some(Boolean)
  const turboChecks = {
    pairedCoverage: total >= minPairs,
    baselineIsolated: baselineContaminated === 0 && baselineIsolationUnknown === 0,
    uesControllerUsed: uesControllerUnproven === 0,
    qualityNonRegression,
    noSuiteRegression,
    noControllerFalsePass: uesFalsePasses === 0,
    speedAcceptable,
    initialInputAcceptable,
    tokensAcceptable,
    efficiencyImproved,
  }
  return {
    schemaVersion: 3,
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
    initialInput: {
      baselineMeanTokens: baselineInitialInput,
      uesMeanTokens: uesInitialInput,
      ratio: initialInputRatio,
      maxRatio: maxInitialInputRatio,
    },
    tokens: {
      baselineMean: baselineTokens,
      uesMean: uesTokens,
      ratio: tokenRatio,
      maxRatio: maxTokenRatio,
    },
    cost: {
      baselineMean: baselineCost,
      uesMean: uesCost,
      ratio: costRatio,
    },
    suites,
    checks,
    promotionEligible: Object.values(checks).every(Boolean),
    turbo: {
      policy: "quality-non-regression-with-efficiency-gain",
      qualityRegressionTolerance,
      baselineContaminated,
      baselineIsolationUnknown,
      uesControllerUnproven,
      uesFalsePasses,
      efficiencyImproved,
      checks: turboChecks,
      promotionEligible: Object.values(turboChecks).every(Boolean),
    },
  }
}