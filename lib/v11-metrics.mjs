function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

export function summarizeV11Efficiency(samples = []) {
  const totals = {
    samples: samples.length,
    stableChars: 0,
    dynamicChars: 0,
    repeatedStableChars: 0,
    externalizedEvidenceBytes: 0,
    evidenceRefs: 0,
    visualRepairAttempts: 0,
    contextExpansions: 0,
    modelEscalations: 0,
    duplicateToolBlocks: 0,
    loopBlocks: 0,
  }

  for (const sample of samples) {
    const cache = sample.promptCache || sample.contextPack?.promptCache || {}
    totals.stableChars += finite(cache.stableChars)
    totals.dynamicChars += finite(cache.dynamicChars)
    totals.repeatedStableChars += finite(sample.repeatedStableChars ?? cache.repeatedStableChars)

    const evidence = sample.evidenceStore || sample.evidence || {}
    totals.externalizedEvidenceBytes += finite(evidence.externalizedBytes ?? evidence.bytes)
    totals.evidenceRefs += finite(evidence.refs ?? sample.evidenceRefs)

    totals.visualRepairAttempts += finite(sample.visualRepairAttempts)
    totals.contextExpansions += finite(sample.contextExpansions)
    totals.modelEscalations += finite(sample.modelEscalations)
    totals.duplicateToolBlocks += finite(sample.duplicateToolBlocks)
    totals.loopBlocks += finite(sample.loopBlocks)
  }

  const inputChars = totals.stableChars + totals.dynamicChars
  return {
    schemaVersion: 1,
    totals,
    cacheablePrefixRatio: ratio(totals.stableChars, inputChars),
    repeatedStableRatio: ratio(totals.repeatedStableChars, totals.stableChars),
    externalizedEvidenceBytesPerSample: ratio(totals.externalizedEvidenceBytes, totals.samples),
    evidenceRefsPerSample: ratio(totals.evidenceRefs, totals.samples),
    visualRepairsPerSample: ratio(totals.visualRepairAttempts, totals.samples),
    contextExpansionsPerSample: ratio(totals.contextExpansions, totals.samples),
    modelEscalationsPerSample: ratio(totals.modelEscalations, totals.samples),
  }
}

export function verifiedSuccessPer100kTokens(results = []) {
  let success = 0
  let tokens = 0
  for (const item of results) {
    if (item.passed === true && item.verified !== false) success += 1
    tokens += finite(item.tokens ?? item.telemetry?.tokens?.total)
  }
  return tokens > 0 ? success / (tokens / 100_000) : null
}
