// V16.17.1 measurement wrapper for the existing V16.15 parallel runtime.
//
// It changes no scheduling/conflict/integration authority. All behavior is
// re-exported from the existing runtime; only waveAccounting is decorated to
// transport the canonical MEASURED char total to the structured-run ledger.
export * from "./parallel-coding-runtime-v16-15.mjs"

import { waveAccounting as baseWaveAccounting } from "./parallel-coding-runtime-v16-15.mjs"
import { SNAPSHOT_FACT } from "./wave-shared-context-v16-15.mjs"
import { recordStructuredContextMeasurement } from "./structured-execution-meter-v16-17.mjs"

export function waveAccounting(input = {}) {
  const accounting = baseWaveAccounting(input)
  try {
    const snapshot = input?.snapshot || null
    const runId = String(snapshot?.facts?.[SNAPSHOT_FACT.WORKSPACE_GENERATION] || "").trim()
    const chars = Number(accounting?.totalWaveChars?.value)
    if (runId && Number.isFinite(chars) && chars >= 0) {
      recordStructuredContextMeasurement({
        runId,
        snapshotId: snapshot?.snapshotId || null,
        waveId: snapshot?.waveId || null,
        chars,
        provenance: "MEASURED",
      })
    }
  } catch {
    // Measurement transport is observational only. A failure here must never
    // affect execution correctness; the ledger will remain NOT_MEASURED.
  }
  return accounting
}
