export function summarizeEvalResults(results) {
  const modes = {}
  for (const item of results) {
    const mode = item.mode || "unknown"
    const bucket = modes[mode] ??= {
      passed: 0,
      total: 0,
      durationMs: 0,
      toolCalls: 0,
      toolSamples: 0,
      tokens: 0,
      tokenSamples: 0,
      cost: 0,
      costSamples: 0,
    }
    bucket.total += 1
    if (item.passed) bucket.passed += 1
    bucket.durationMs += Number(item.durationMs) || 0

    if ((item.telemetry?.jsonLines || 0) > 0) {
      bucket.toolCalls += Number(item.telemetry?.toolCalls) || 0
      bucket.toolSamples += 1
    }
    if ((item.telemetry?.usageSamples || 0) > 0) {
      bucket.tokens += Number(item.telemetry?.tokens?.total) || 0
      bucket.tokenSamples += 1
    }
    if ((item.telemetry?.costSamples || 0) > 0) {
      bucket.cost += Number(item.telemetry?.cost) || 0
      bucket.costSamples += 1
    }
  }

  for (const bucket of Object.values(modes)) {
    bucket.passRate = bucket.total ? bucket.passed / bucket.total : 0
    bucket.avgDurationMs = bucket.total ? bucket.durationMs / bucket.total : 0
    bucket.avgToolCalls = bucket.toolSamples ? bucket.toolCalls / bucket.toolSamples : null
    bucket.avgTokens = bucket.tokenSamples ? bucket.tokens / bucket.tokenSamples : null
    bucket.avgCost = bucket.costSamples ? bucket.cost / bucket.costSamples : null
    bucket.telemetryCoverage = {
      tools: bucket.total ? bucket.toolSamples / bucket.total : 0,
      tokens: bucket.total ? bucket.tokenSamples / bucket.total : 0,
      cost: bucket.total ? bucket.costSamples / bucket.total : 0,
    }
    delete bucket.durationMs
    delete bucket.toolCalls
    delete bucket.toolSamples
    delete bucket.tokens
    delete bucket.tokenSamples
    delete bucket.cost
    delete bucket.costSamples
  }

  const byTaskMap = new Map()
  for (const item of results) {
    const task = byTaskMap.get(item.task) || {}
    const bucket = task[item.mode] || { passed: 0, total: 0 }
    bucket.total += 1
    if (item.passed) bucket.passed += 1
    bucket.passRate = bucket.passed / bucket.total
    task[item.mode] = bucket
    byTaskMap.set(item.task, task)
  }

  const baseline = modes.baseline?.passRate
  const ues = modes.ues?.passRate
  return {
    modes,
    passRateDelta: typeof baseline === "number" && typeof ues === "number" ? ues - baseline : null,
    byTask: Object.fromEntries([...byTaskMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}
