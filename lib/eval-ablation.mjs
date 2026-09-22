function finite(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function modeSummary(value) {
  return value?.summary?.modes?.ues || value?.modes?.ues || null
}

function ratio(candidate, reference) {
  return candidate != null && reference != null && reference > 0
    ? candidate / reference
    : null
}

function delta(candidate, reference) {
  return candidate != null && reference != null ? candidate - reference : null
}

export function compareEvalSummaries(reference, candidate, options = {}) {
  const ref = modeSummary(reference)
  const next = modeSummary(candidate)
  if (!ref || !next) throw new Error("reference and candidate must contain a UES mode summary")

  const passRateTolerance = Math.max(0, Number(options.passRateTolerance || 0))
  const minInitialInputReduction = Math.max(0, Number(options.minInitialInputReduction ?? 0.10))
  const maxTotalTokenRatio = Math.max(0.01, Number(options.maxTotalTokenRatio || 1.05))
  const maxDurationRatio = Math.max(0.01, Number(options.maxDurationRatio || 1.10))
  const minCacheableRatio = options.minCacheableRatio == null ? null : Math.max(0, Math.min(1, Number(options.minCacheableRatio)))
  const minEvidenceReuseRatio = options.minEvidenceReuseRatio == null ? null : Math.max(0, Math.min(1, Number(options.minEvidenceReuseRatio)))

  const referencePassRate = finite(ref.passRate)
  const candidatePassRate = finite(next.passRate)
  const referenceInitialInput = finite(ref.avgInitialInputTokens)
  const candidateInitialInput = finite(next.avgInitialInputTokens)
  const referenceTokens = finite(ref.avgTokens)
  const candidateTokens = finite(next.avgTokens)
  const referenceDuration = finite(ref.avgDurationMs)
  const candidateDuration = finite(next.avgDurationMs)
  const referenceCacheableRatio = finite(ref.avgCacheableRatio)
  const candidateCacheableRatio = finite(next.avgCacheableRatio)
  const referenceEvidenceReuseRatio = finite(ref.avgEvidenceReuseRatio)
  const candidateEvidenceReuseRatio = finite(next.avgEvidenceReuseRatio)
  const candidateRepeatedStableChars = finite(next.avgRepeatedStableChars)

  const initialInputRatio = ratio(candidateInitialInput, referenceInitialInput)
  const tokenRatio = ratio(candidateTokens, referenceTokens)
  const durationRatio = ratio(candidateDuration, referenceDuration)

  const checks = {
    passRatePreserved:
      referencePassRate != null &&
      candidatePassRate != null &&
      candidatePassRate >= referencePassRate - passRateTolerance,
    initialInputReduced:
      initialInputRatio == null
        ? null
        : initialInputRatio <= 1 - minInitialInputReduction,
    totalTokensBounded:
      tokenRatio == null ? null : tokenRatio <= maxTotalTokenRatio,
    durationBounded:
      durationRatio == null ? null : durationRatio <= maxDurationRatio,
    cacheableRatioTarget:
      minCacheableRatio == null ? null :
      candidateCacheableRatio == null ? null :
      candidateCacheableRatio >= minCacheableRatio,
    evidenceReuseTarget:
      minEvidenceReuseRatio == null ? null :
      candidateEvidenceReuseRatio == null ? null :
      candidateEvidenceReuseRatio >= minEvidenceReuseRatio,
  }

  const efficiencyEvidence = [
    checks.initialInputReduced,
    checks.totalTokensBounded,
    checks.durationBounded,
  ].filter((value) => value !== null)

  return {
    schemaVersion: 1,
    kind: "ues-eval-ablation",
    thresholds: {
      passRateTolerance,
      minInitialInputReduction,
      maxTotalTokenRatio,
      maxDurationRatio,
      minCacheableRatio,
      minEvidenceReuseRatio,
    },
    reference: {
      passRate: referencePassRate,
      avgInitialInputTokens: referenceInitialInput,
      avgTokens: referenceTokens,
      avgDurationMs: referenceDuration,
      avgCacheableRatio: referenceCacheableRatio,
      avgEvidenceReuseRatio: referenceEvidenceReuseRatio,
    },
    candidate: {
      passRate: candidatePassRate,
      avgInitialInputTokens: candidateInitialInput,
      avgTokens: candidateTokens,
      avgDurationMs: candidateDuration,
      avgCacheableRatio: candidateCacheableRatio,
      avgEvidenceReuseRatio: candidateEvidenceReuseRatio,
      avgRepeatedStableChars: candidateRepeatedStableChars,
    },
    delta: {
      passRate: delta(candidatePassRate, referencePassRate),
      avgInitialInputTokens: delta(candidateInitialInput, referenceInitialInput),
      avgTokens: delta(candidateTokens, referenceTokens),
      avgDurationMs: delta(candidateDuration, referenceDuration),
      avgCacheableRatio: delta(candidateCacheableRatio, referenceCacheableRatio),
      avgEvidenceReuseRatio: delta(candidateEvidenceReuseRatio, referenceEvidenceReuseRatio),
    },
    ratios: {
      initialInput: initialInputRatio,
      totalTokens: tokenRatio,
      duration: durationRatio,
    },
    checks,
    telemetrySufficient: checks.initialInputReduced !== null,
    optionalTargetsSatisfied:
      (checks.cacheableRatioTarget == null || checks.cacheableRatioTarget === true) &&
      (checks.evidenceReuseTarget == null || checks.evidenceReuseTarget === true),
    gateEligible:
      checks.passRatePreserved === true &&
      checks.initialInputReduced === true &&
      efficiencyEvidence.every((value) => value === true) &&
      (checks.cacheableRatioTarget == null || checks.cacheableRatioTarget === true) &&
      (checks.evidenceReuseTarget == null || checks.evidenceReuseTarget === true),
  }
}
