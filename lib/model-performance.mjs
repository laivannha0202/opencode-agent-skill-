  // enough observations is allowed to move routing.
  if (normalized.samples < minSamples) {
    return { adjustment: 0, confidence, record: normalized, lowerBound }
  }

  const correctness = (lowerBound - 0.5) * 80
  const retryPenalty = Math.min(20, normalized.avgRetries * 5)
  const latencyPenalty = normalized.avgLatencyMs > 0
    ? Math.min(10, Math.max(0, Math.log10(Math.max(1, normalized.avgLatencyMs / 1000)) * 3))
    : 0
  return {
    adjustment: (correctness - retryPenalty - latencyPenalty) * confidence,
    confidence,
    record: normalized,
    lowerBound,
  }
}

export function rerankCapabilitySelection(selection = {}, history = {}, options = {}) {
  const taskClass = inferTaskClass(options.text || "", { taskClass: options.taskClass })
  const minSamples = Math.max(1, Number(options.minSamples || 8))
  const normalized = normalizePerformanceHistory(history)
  const candidates = (selection.candidates || []).map((candidate) => {
    const record = normalized[candidate.id]?.[taskClass] || normalized[candidate.id]?.overall || null
    const evidence = performanceAdjustment(record, minSamples)
    return {
      ...candidate,
      baseScore: Number(candidate.score || 0),
      empiricalTaskClass: taskClass,
      empiricalEvidence: evidence.record,
      empiricalConfidence: Number(evidence.confidence.toFixed(4)),
      empiricalPassLowerBound: Number(evidence.lowerBound.toFixed(4)),
      adjustedScore: Number((Number(candidate.score || 0) + evidence.adjustment).toFixed(6)),
    }
  })
  const eligible = candidates.filter((candidate) => candidate.eligible)
    .sort((a, b) => b.adjustedScore - a.adjustedScore || b.baseScore - a.baseScore)
  return { ...selection, selected: eligible[0] || null, candidates, taskClass, empirical: true }
}