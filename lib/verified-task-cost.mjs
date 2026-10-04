// V16.4 Slice F (part 1): VerifiedTaskCost.
//
// A unified cost metric that is ONLY meaningful when the local verifier
// PASSED. Correctness is never mixed with cost: without verifiedPass the
// report carries costAvailable=false and no cost number.
//
// Provenance per component: MEASURED | DERIVED_FROM_MEASURED | NOT_MEASURED.
// Missing token fields are reported null/partial, never fabricated as zero.

export const COST_PROVENANCE = Object.freeze({
  MEASURED: "measured",
  DERIVED: "derived-from-measured",
  NOT_MEASURED: "not-measured",
});

function measured(value) {
  if (value === null || value === undefined || value === "") return { value: null, provenance: COST_PROVENANCE.NOT_MEASURED };
  const n = Number(value);
  if (!Number.isFinite(n)) return { value: null, provenance: COST_PROVENANCE.NOT_MEASURED };
  return { value: n, provenance: COST_PROVENANCE.MEASURED };
}

export function reportVerifiedTaskCost(input = {}) {
  const verifiedPass = input.verifiedPass === true;
  if (!verifiedPass) {
    return { verifiedPass: false, costAvailable: false, verifiedTaskCost: null, components: null, provenance: COST_PROVENANCE.NOT_MEASURED };
  }
  const providerInput = measured(input.providerInputTokens);
  const providerOutput = measured(input.providerOutputTokens);
  const cacheRead = measured(input.cacheReadTokens);
  const cacheWrite = measured(input.cacheWriteTokens);
  const wallMs = measured(input.wallTimeMs);
  const genMs = measured(input.modelGenerationMs);
  const toolMs = measured(input.toolExecutionMs);
  const tokensKnown = providerInput.value !== null && providerOutput.value !== null;
  const derivedTotal = tokensKnown ? providerInput.value + providerOutput.value : null;
  const components = {
    providerInputTokens: providerInput,
    providerOutputTokens: providerOutput,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    toolCalls: measured(input.toolCalls),
    browserToolCalls: measured(input.browserToolCalls),
    retries: measured(input.retries),
    consultations: measured(input.consultations),
    followUps: measured(input.followUps),
    verifierAttempts: measured(input.verifierAttempts),
    wallTimeMs: wallMs,
    modelGenerationMs: genMs,
    toolExecutionMs: toolMs,
  };
  const anyMeasured = Object.values(components).some((c) => c.provenance === COST_PROVENANCE.MEASURED);
  return {
    verifiedPass: true,
    costAvailable: anyMeasured,
    verifiedTaskCost: derivedTotal === null ? null : {
      providerTokensTotal: derivedTotal,
      provenance: COST_PROVENANCE.DERIVED,
    },
    partial: !tokensKnown,
    components,
    provenance: tokensKnown ? COST_PROVENANCE.DERIVED : (anyMeasured ? COST_PROVENANCE.MEASURED : COST_PROVENANCE.NOT_MEASURED),
  };
}
