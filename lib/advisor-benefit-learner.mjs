// V16.4 Slice F (part 2): advisor benefit learner (bounded, observational).
//
// The learner NEVER changes correctness policy: it cannot disable the
// verifier or security gates and cannot auto-force external web use. It only
// nudges the AUTO consultation weight after a minimum sample floor, with
// hysteresis, and insufficient data stays NEUTRAL. State is bounded with GC.

export const ADVISOR_WEIGHT = Object.freeze({
  CONSULT: "consult",
  LOCAL: "local",
  NEUTRAL: "neutral",
});

export const LEARNER_LIMIT = Object.freeze({
  minSamples: 8,
  maxKeys: 500,
  hysteresisMargin: 0.15,
});

function keyOf(sample = {}) {
  return [
    String(sample.taskClass || "unknown"),
    String(sample.subsystemBucket || "s1"),
    String(sample.ambiguityClass || "low"),
    String(sample.failureClass || "none"),
    String(sample.provider || "deepseek-web"),
  ].join("|");
}

const store = new Map();

export function resetAdvisorLearnerForTests() {
  store.clear();
}

export function learnerSizeForTests() {
  return store.size;
}

export function recordAdvisorOutcome(sample = {}) {
  const key = keyOf(sample);
  let row = store.get(key);
  if (!row) {
    if (store.size >= LEARNER_LIMIT.maxKeys) {
      // Bounded GC: evict the oldest key (insertion order).
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
    row = { samples: 0, consultBeneficial: 0, consultHarmful: 0, toolDeltaSum: 0, timeDeltaSum: 0 };
    store.set(key, row);
  }
  row.samples += 1;
  if (sample.consulted === true && sample.accepted === true && sample.verifiedPass === true) {
    row.consultBeneficial += 1;
  }
  if (sample.consulted === true && (sample.accepted === false || sample.verifiedPass === false)) {
    row.consultHarmful += 1;
  }
  if (Number.isFinite(Number(sample.toolCallDelta))) row.toolDeltaSum += Number(sample.toolCallDelta);
  if (Number.isFinite(Number(sample.wallTimeDeltaMs))) row.timeDeltaSum += Number(sample.wallTimeDeltaMs);
  return { key, samples: row.samples };
}

/**
 * Expected-benefit weight for AUTO routing. Returns NEUTRAL below the sample
 * floor or inside the hysteresis band.
 */
export function advisorWeight(sample = {}) {
  const row = store.get(keyOf(sample));
  if (!row || row.samples < LEARNER_LIMIT.minSamples) return { weight: ADVISOR_WEIGHT.NEUTRAL, reason: "insufficient-data" };
  const benefitRate = row.consultBeneficial / row.samples;
  const harmRate = row.consultHarmful / row.samples;
  if (benefitRate - harmRate > LEARNER_LIMIT.hysteresisMargin) {
    return { weight: ADVISOR_WEIGHT.CONSULT, reason: "historically-beneficial", benefitRate, samples: row.samples };
  }
  if (harmRate - benefitRate > LEARNER_LIMIT.hysteresisMargin) {
    return { weight: ADVISOR_WEIGHT.LOCAL, reason: "historically-not-beneficial", benefitRate, samples: row.samples };
  }
  return { weight: ADVISOR_WEIGHT.NEUTRAL, reason: "inside-hysteresis-band", samples: row.samples };
}
