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
      initialInputTokens: 0,
      initialInputSamples: 0,
      cost: 0,
      costSamples: 0,
      cacheableRatio: 0,
      cacheableRatioSamples: 0,
      repeatedStableChars: 0,
      repeatedStableSamples: 0,
      repeatedStableRatio: 0,
      repeatedStableRatioSamples: 0,
      evidenceReuseRatio: 0,
      evidenceReuseSamples: 0,
      visualRepairAttempts: 0,
      visualRepairSamples: 0,
      contextExpansions: 0,
      contextExpansionSamples: 0,
      modelEscalations: 0,
      modelEscalationSamples: 0,
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
    const initialInput = Number(item.telemetry?.firstUsage?.input)
    if (Number.isFinite(initialInput)) {
      bucket.initialInputTokens += initialInput
      bucket.initialInputSamples += 1
    }
    if ((item.telemetry?.costSamples || 0) > 0) {
      bucket.cost += Number(item.telemetry?.cost) || 0
      bucket.costSamples += 1
    }

    const v11 = item.telemetry?.v11 || {}
    if (Number.isFinite(Number(v11.avgCacheableRatio))) {
      bucket.cacheableRatio += Number(v11.avgCacheableRatio)
      bucket.cacheableRatioSamples += 1
    }
    if (Number.isFinite(Number(v11.repeatedStableChars))) {
      bucket.repeatedStableChars += Number(v11.repeatedStableChars)
      bucket.repeatedStableSamples += 1
    }
    if (Number.isFinite(Number(v11.repeatedStableRatio))) {
      bucket.repeatedStableRatio += Number(v11.repeatedStableRatio)
      bucket.repeatedStableRatioSamples += 1
    }
    if (Number.isFinite(Number(v11.evidenceReuseRatio))) {
      bucket.evidenceReuseRatio += Number(v11.evidenceReuseRatio)
      bucket.evidenceReuseSamples += 1
    }
    if (Number.isFinite(Number(v11.visualRepairAttempts))) {
      bucket.visualRepairAttempts += Number(v11.visualRepairAttempts)
      bucket.visualRepairSamples += 1
    }
    if (Number.isFinite(Number(v11.contextExpansions))) {
      bucket.contextExpansions += Number(v11.contextExpansions)
      bucket.contextExpansionSamples += 1
    }
    if (Number.isFinite(Number(v11.modelEscalations))) {
      bucket.modelEscalations += Number(v11.modelEscalations)
      bucket.modelEscalationSamples += 1
    }
  }

  for (const bucket of Object.values(modes)) {
    bucket.passRate = bucket.total ? bucket.passed / bucket.total : 0
    bucket.avgDurationMs = bucket.total ? bucket.durationMs / bucket.total : 0
    bucket.avgToolCalls = bucket.toolSamples ? bucket.toolCalls / bucket.toolSamples : null
    bucket.avgTokens = bucket.tokenSamples ? bucket.tokens / bucket.tokenSamples : null
    bucket.avgInitialInputTokens = bucket.initialInputSamples ? bucket.initialInputTokens / bucket.initialInputSamples : null
    bucket.avgCost = bucket.costSamples ? bucket.cost / bucket.costSamples : null
    bucket.avgCacheableRatio = bucket.cacheableRatioSamples ? bucket.cacheableRatio / bucket.cacheableRatioSamples : null
    bucket.avgRepeatedStableChars = bucket.repeatedStableSamples ? bucket.repeatedStableChars / bucket.repeatedStableSamples : null
    bucket.avgRepeatedStableRatio = bucket.repeatedStableRatioSamples ? bucket.repeatedStableRatio / bucket.repeatedStableRatioSamples : null
    bucket.avgEvidenceReuseRatio = bucket.evidenceReuseSamples ? bucket.evidenceReuseRatio / bucket.evidenceReuseSamples : null
    bucket.avgVisualRepairAttempts = bucket.visualRepairSamples ? bucket.visualRepairAttempts / bucket.visualRepairSamples : null
    bucket.avgContextExpansions = bucket.contextExpansionSamples ? bucket.contextExpansions / bucket.contextExpansionSamples : null
    bucket.avgModelEscalations = bucket.modelEscalationSamples ? bucket.modelEscalations / bucket.modelEscalationSamples : null
    bucket.telemetryCoverage = {
      tools: bucket.total ? bucket.toolSamples / bucket.total : 0,
      tokens: bucket.total ? bucket.tokenSamples / bucket.total : 0,
      initialInputTokens: bucket.total ? bucket.initialInputSamples / bucket.total : 0,
      cost: bucket.total ? bucket.costSamples / bucket.total : 0,
      cacheableRatio: bucket.total ? bucket.cacheableRatioSamples / bucket.total : 0,
      repeatedStableChars: bucket.total ? bucket.repeatedStableSamples / bucket.total : 0,
      repeatedStableRatio: bucket.total ? bucket.repeatedStableRatioSamples / bucket.total : 0,
      evidenceReuseRatio: bucket.total ? bucket.evidenceReuseSamples / bucket.total : 0,
      visualRepairAttempts: bucket.total ? bucket.visualRepairSamples / bucket.total : 0,
      contextExpansions: bucket.total ? bucket.contextExpansionSamples / bucket.total : 0,
      modelEscalations: bucket.total ? bucket.modelEscalationSamples / bucket.total : 0,
    }
    delete bucket.durationMs
    delete bucket.toolCalls
    delete bucket.toolSamples
    delete bucket.tokens
    delete bucket.tokenSamples
    delete bucket.initialInputTokens
    delete bucket.initialInputSamples
    delete bucket.cost
    delete bucket.costSamples
    delete bucket.cacheableRatio
    delete bucket.cacheableRatioSamples
    delete bucket.repeatedStableChars
    delete bucket.repeatedStableSamples
    delete bucket.repeatedStableRatio
    delete bucket.repeatedStableRatioSamples
    delete bucket.evidenceReuseRatio
    delete bucket.evidenceReuseSamples
    delete bucket.visualRepairAttempts
    delete bucket.visualRepairSamples
    delete bucket.contextExpansions
    delete bucket.contextExpansionSamples
    delete bucket.modelEscalations
    delete bucket.modelEscalationSamples
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
