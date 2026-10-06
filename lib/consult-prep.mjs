// V16.4 Slice H: parallel read-only consultation preparation.
//
// When escalation=true, Lane A (provider capability/readiness + session
// health) and Lane B (repo retrieval, packet assembly, evidence gathering,
// redaction, local fingerprint) run concurrently. Both lanes are READ-ONLY:
// fill / click / Send and any external side effect are never parallelized and
// happen only at the join point. If either lane fails, AUTO falls back to
// local and FORCE reports WEB_REASONING_UNAVAILABLE.
//
// V16.7.1 hardening: timeoutMs is now an actual deadline. A shared AbortSignal
// is passed to both lanes so cooperative browser/retrieval work can stop. A lane
// that cannot abort may finish later, but its result is detached and can never
// cross the already-resolved join. No provider submit happens inside this helper.

function safeError(error) {
  if (!error) return null;
  const name = String(error?.name || "").trim();
  const code = String(error?.code || "").trim();
  if (code) return code.slice(0, 160);
  if (name && name !== "Error") return name.slice(0, 160);
  return "consult-prep-error";
}

function timeoutFailure(mode, telemetry) {
  if (String(mode).toLowerCase() === "force") {
    return {
      ok: false,
      code: "WEB_REASONING_UNAVAILABLE",
      fallbackToLocal: false,
      laneA: "consult-prep-timeout",
      laneB: "consult-prep-timeout",
      telemetry,
    };
  }
  return {
    ok: false,
    code: "CONSULT_PREP_FALLBACK_LOCAL",
    fallbackToLocal: true,
    laneA: "consult-prep-timeout",
    laneB: "consult-prep-timeout",
    telemetry,
  };
}

export async function prepareConsultationParallel({
  laneA,
  laneB,
  mode = "auto",
  timeoutMs = 30_000,
  signal: parentSignal,
} = {}) {
  const started = Date.now();
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.max(1, Math.trunc(Number(timeoutMs)))
    : 30_000;
  const telemetry = {
    laneAMs: null,
    laneBMs: null,
    joinMs: null,
    parallel: true,
    timeoutMs: deadlineMs,
    timedOut: false,
    aborted: false,
  };

  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    telemetry.aborted = true;
  };
  const onParentAbort = () => abort(parentSignal?.reason || "consult-prep-parent-abort");
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });

  const runLane = async (name, fn) => {
    const laneStarted = Date.now();
    try {
      if (typeof fn !== "function") throw new TypeError(`${name}-missing`);
      if (controller.signal.aborted) throw controller.signal.reason || new Error("consult-prep-aborted");
      const value = await fn({ signal: controller.signal });
      if (name === "laneA") telemetry.laneAMs = Date.now() - laneStarted;
      else telemetry.laneBMs = Date.now() - laneStarted;
      return { ok: true, value };
    } catch (error) {
      if (name === "laneA") telemetry.laneAMs = Date.now() - laneStarted;
      else telemetry.laneBMs = Date.now() - laneStarted;
      return { ok: false, error };
    }
  };

  // Invoke both lanes before awaiting either. This is the production overlap
  // contract: capability/warmup and deterministic packet preparation begin in
  // the same turn of the event loop.
  const lanesPromise = Promise.all([
    runLane("laneA", laneA),
    runLane("laneB", laneB),
  ]);
  // If a non-cooperative lane outlives the deadline, it is detached safely: all
  // lane failures are captured by runLane, so no late unhandled rejection can
  // escape after the caller has fallen back.
  lanesPromise.catch(() => {});

  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      telemetry.timedOut = true;
      abort("consult-prep-timeout");
      resolve({ timedOut: true });
    }, deadlineMs);
    timer.unref?.();
  });

  try {
    const winner = await Promise.race([
      lanesPromise.then((value) => ({ timedOut: false, value })),
      timeoutPromise,
    ]);
    telemetry.joinMs = Date.now() - started;

    if (winner?.timedOut) return timeoutFailure(mode, telemetry);

    const [aResult, bResult] = winner.value;
    const aError = aResult.ok ? null : aResult.error;
    const bError = bResult.ok ? null : bResult.error;
    if (aError || bError) {
      if (String(mode).toLowerCase() === "force") {
        return {
          ok: false,
          code: "WEB_REASONING_UNAVAILABLE",
          fallbackToLocal: false,
          laneA: safeError(aError),
          laneB: safeError(bError),
          telemetry,
        };
      }
      return {
        ok: false,
        code: "CONSULT_PREP_FALLBACK_LOCAL",
        fallbackToLocal: true,
        laneA: safeError(aError),
        laneB: safeError(bError),
        telemetry,
      };
    }
    return { ok: true, laneA: aResult.value, laneB: bResult.value, telemetry };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  }
}
