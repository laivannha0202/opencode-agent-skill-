// V16.4 Slice H: parallel read-only consultation preparation.
//
// When escalation=true, Lane A (provider capability/readiness + session
// health) and Lane B (repo retrieval, packet assembly, evidence gathering,
// redaction, local fingerprint) run concurrently. Both lanes are READ-ONLY:
// fill / click / Send and any external side effect are never parallelized and
// happen only at the join point. If either lane fails, AUTO falls back to
// local and FORCE reports WEB_REASONING_UNAVAILABLE.

export async function prepareConsultationParallel({ laneA, laneB, mode = "auto", timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  const telemetry = { laneAMs: null, laneBMs: null, joinMs: null, parallel: true };
  // Lanes are invoked synchronously below so both start before either is
  // awaited; Promise.all joins them. Side-effecting submit happens only
  // after this function returns ok:true.
  let aResult;
  let bResult;
  let aError = null;
  let bError = null;
  const aStarted = Date.now();
  const bStarted = Date.now();
  const [aSettled, bSettled] = await Promise.all([
    (async () => { try { return { ok: true, value: await laneA() }; } catch (error) { return { ok: false, error }; } })(),
    (async () => { try { return { ok: true, value: await laneB() }; } catch (error) { return { ok: false, error }; } })(),
  ]);
  telemetry.laneAMs = Date.now() - aStarted;
  telemetry.laneBMs = Date.now() - bStarted;
  aResult = aSettled;
  bResult = bSettled;
  if (!aResult.ok) aError = aResult.error;
  if (!bResult.ok) bError = bResult.error;
  telemetry.joinMs = Date.now() - started;
  if (aError || bError) {
    if (String(mode).toLowerCase() === "force") {
      return {
        ok: false,
        code: "WEB_REASONING_UNAVAILABLE",
        fallbackToLocal: false,
        laneA: aError ? String(aError.message || aError) : null,
        laneB: bError ? String(bError.message || bError) : null,
        telemetry,
      };
    }
    return {
      ok: false,
      code: "CONSULT_PREP_FALLBACK_LOCAL",
      fallbackToLocal: true,
      laneA: aError ? String(aError.message || aError) : null,
      laneB: bError ? String(bError.message || bError) : null,
      telemetry,
    };
  }
  return { ok: true, laneA: aResult.value, laneB: bResult.value, telemetry };
}
