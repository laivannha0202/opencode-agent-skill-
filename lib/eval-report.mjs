export function summarizeEvalResults(results) {
  const modes = {}
  for (const item of results) {
    const mode = item.mode || "unknown"
    const bucket = modes[mode] ??= {
      passed: 0,
      total: 0,
      durationMs: 0,
      toolCalls: 0,
      tokens: 0,
      cost: 0,
    }
    bucket.total += 1
    if (item.passed) bucket.passed += 1
    bucket.durationMs += Number(item.durationMs) || 0
    bucket.toolCalls += Number(item.telemetry?.toolCalls) || 0
    bucket.tokens += Number(item.telemetry?.tokens?.total) || 0
    bucket.cost += Number(item.telemetry?.cost) || 0
  }

  for (const bucket of Object.values(modes)) {
    bucket.passRate = bucket.total ? bucket.passed / bucket.total : 0
    bucket.avgDurationMs = bucket.total ? bucket.durationMs / bucket.total : 0
    bucket.avgToolCalls = bucket.total ? bucket.toolCalls / bucket.total : 0
    bucket.avgTokens = bucket.total ? bucket.tokens / bucket.total : 0
    bucket.avgCost = bucket.total ? bucket.cost / bucket.total : 0
    delete bucket.durationMs
    delete bucket.toolCalls
    delete bucket.tokens
    delete bucket.cost
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
