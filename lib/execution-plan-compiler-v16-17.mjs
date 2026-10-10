import { createHash } from "node:crypto"
import {
  computeSafeWaves,
  taskReadFiles,
  taskVerificationCommands,
  taskWriteFiles,
} from "./task-graph.mjs"
import { buildDelegationWaves, classifyScope } from "./delegation-safety.mjs"
import { decideParallelExecution } from "./parallel-execution-policy-v16-15.mjs"

export const EXECUTION_PLAN_COMPILER_POLICY = "execution-plan-compiler-v16-17"
export const EXECUTION_PLAN_COMPILER_SCHEMA_VERSION = 1

const DECISION = Object.freeze({
  SERIAL: "SERIAL",
  PARALLEL: "PARALLEL",
  PARENT_DIRECT: "PARENT_DIRECT",
})

export const EXECUTION_PLAN_DECISION = DECISION

function strList(value) {
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * V16.17 Execution Plan Compiler (§2): the ONE run-level immutable plan.
 *
 * COMPILE ONCE → every wave executes the compiled decision. The compiler
 * composes the existing single authorities and adds no policy of its own:
 *   - order         → `computeSafeWaves` (task-graph owns dependency topology)
 *   - conflicts     → `buildDelegationWaves` (delegation-safety owns conflicts)
 *   - economy       → `decideParallelExecution` (policy owns SERIAL/PARALLEL)
 *   - cost          → injected `reserve` (the run ledger owns admission)
 *
 * The compiled waves carry `conflictWaves` (positional `indexes` into the
 * caller's scope array). `runDelegationWave({ waves })` executes exactly those
 * waves: it never re-derives conflicts, so downstream CANNOT turn a compiled
 * SERIAL wave back into PARALLEL. Concurrency from the plan is an UPPER BOUND:
 * the executor may only narrow it (`Math.min`), never widen it.
 *
 * Admission (worktrees / prewarm / RPC children / DeepSeek / browser) is
 * decided HERE, before any expensive effect exists. The executor creates only
 * what the admission record allows. CUMULATIVE run-budget admission is NOT
 * decided here: every wave would observe the same initial spent state, so it
 * runs at wave-execution time against the CURRENT run ledger (the compiler
 * carries only the stateless per-wave cost REQUEST/estimate).
 */
export function buildExecutionScopes(tasks = [], options = {}) {
  const riskOf = typeof options.riskOf === "function" ? options.riskOf : () => "medium"
  return (Array.isArray(tasks) ? tasks : []).map((task) => {
    const writeFiles = taskWriteFiles(task)
    return {
      id: String(task?.id || ""),
      readOnly: writeFiles.length === 0,
      writeFiles,
      readFiles: taskReadFiles(task),
      task: [task?.title, task?.summary].filter(Boolean).join(" "),
      acceptance: Array.isArray(task?.acceptance) ? task.acceptance : [],
      verificationCommands: taskVerificationCommands(task)
        .map((spec) => [spec.command, ...((spec && spec.args) || [])].join(" ")),
      services: Array.isArray(task?.services)
        ? task.services
        : Array.isArray(task?.mutableServices) ? task.mutableServices : [],
      externalEffects: Array.isArray(task?.externalEffects)
        ? task.externalEffects
        : Array.isArray(task?.sideEffects) ? task.sideEffects : [],
      generatedOutputs: Array.isArray(task?.generatedOutputs) ? task.generatedOutputs : [],
      commands: Array.isArray(task?.commands)
        ? task.commands
        : Array.isArray(task?.plannedCommands) ? task.plannedCommands : [],
      risk: riskOf(task),
    }
  })
}

function compileWave({ waveIndex, tasks, context }) {
  const {
    maxConcurrency,
    maxWriters,
    readOnlyWorkUseful,
    unresolvedResearch,
    resourcePressure,
    finalRelease,
    history,
    requestedReadOnly,
    reserve,
  } = context
  const scopes = buildExecutionScopes(tasks, { riskOf: context.riskOf })
  const writerCount = scopes.filter((scope) => scope.readOnly !== true).length
  // The attempt-local writer cap mirrors the executor's fleet bound: writer
  // waves never exceed maxWriters, reader waves may use the full bound.
  const waveCap = writerCount > 0
    ? Math.max(1, Math.min(maxConcurrency, Number(maxWriters) || maxConcurrency))
    : maxConcurrency
  // Classify BEFORE the conflict compiler: `buildDelegationWaves` reports
  // positional indexes by object identity, so it must receive the classified
  // objects it will actually pack (passing unclassified scopes would silently
  // produce `indexes: [-1]` waves that execute nothing). Order is preserved,
  // so the indexes stay aligned with the caller's same-ordered scope array.
  const classified = scopes.map((scope) => classifyScope({
    ...scope,
    childId: scope.id,
    role: scope.id,
    files: [...scope.writeFiles, ...scope.readFiles],
  }))
  const conflict = buildDelegationWaves(classified, { maxParallel: waveCap })
  const economy = decideParallelExecution({
    scopes,
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: scopes.some((scope) => scope.risk === "high") ? "high" : "medium",
    readOnlyWorkUseful: readOnlyWorkUseful === true
      || scopes.some((scope) => scope.readOnly === true),
    unresolvedResearch: unresolvedResearch === true,
    resourcePressure: resourcePressure || null,
    finalRelease: finalRelease === true,
    history: history || null,
    options: {
      requestedWriters: waveCap,
      requestedReadOnly: requestedReadOnly ?? maxConcurrency,
    },
    requestedWriters: waveCap,
    requestedReadOnly: requestedReadOnly ?? maxConcurrency,
  })

  // The economy's own spawn flags are stored VERBATIM: snapshot and prewarm
  // gating must match the retired per-wave `planWave` behavior exactly
  // (parallel postures spawn; serial-structured and parent-direct do not).
  // PARENT_DIRECT is only meaningful for a single tiny task: a wave with two
  // conflicting writers is a real multi-task wave and must fall back to
  // SERIAL, never parent-direct (parent-direct has no worktree isolation).
  const spawnsChildren = economy?.spawnsChildren === true
  const spawnsWriters = economy?.spawnsWriters === true
  const parentDirect = economy?.parentDirect === true && tasks.length <= 1
  let decision = DECISION.SERIAL
  if (parentDirect) decision = DECISION.PARENT_DIRECT
  else if ((spawnsWriters || spawnsChildren)
    && scopes.length > 1 && conflict.parallelWaves > 0) {
    decision = DECISION.PARALLEL
  }
  // CONCURRENCY FOLLOWS THE DECISION. A compiled SERIAL or PARENT_DIRECT wave
  // is executed serially BY CONSTRUCTION: giving it the economy's higher
  // number would let a downstream consumer read `concurrency: 2` and run two
  // children of a wave the policy refused to parallelize. Only a PARALLEL
  // decision carries a parallelism bound, and that bound is an UPPER limit the
  // executor may narrow, never widen.
  const concurrency = decision === DECISION.PARALLEL
    ? Math.max(1, Math.min(waveCap, Math.trunc(Number(economy?.concurrency) || 1)))
    : 1
  let effectiveConcurrency = concurrency

  let reservation = null
  if (typeof reserve === "function") {
    try {
      reservation = reserve({
        waveIndex,
        taskIds: tasks.map((task) => String(task?.id || "")),
        simultaneousCalls: decision === DECISION.PARENT_DIRECT ? 0 : effectiveConcurrency,
        childTurns: Math.max(1, tasks.length * 2),
        subprocessSlots: decision === DECISION.PARENT_DIRECT ? 0 : tasks.length,
        testSlots: decision === DECISION.PARENT_DIRECT ? 0 : tasks.length,
        taskShape: writerCount > 1 ? "COMPLEX" : writerCount === 1 ? "MEDIUM" : "SMALL",
        decision,
      }) || null
    } catch {
      reservation = null
    }
  }
  if (reservation && typeof reservation === "object"
    && reservation.admitted !== true
    && (reservation.action === "serialize" || reservation.action === "parent-direct")) {
    // A refused wave is a real multi-task wave: it must fall back to SERIAL
    // (worktree isolation + verifier gate), never parent-direct, which has
    // no sandbox and no verifier.
    decision = DECISION.SERIAL
    // The downgrade must also lower the NUMERAL: a consumer reading the
    // compiled `concurrency` after a budget refusal never sees the refused
    // parallel number.
    effectiveConcurrency = 1
  }

  // Admission is decided HERE, before any expensive effect exists. The
  // executor creates only what this record allows. Model workers are
  // explicitly required for semantic work (an RPC child per task at most);
  // everything else defaults to zero and must be individually admitted.
  const admission = {
    createWorktrees: decision !== DECISION.PARENT_DIRECT && writerCount > 0,
    prewarm: (spawnsChildren || spawnsWriters) && tasks.length > 1,
    rpcChildren: tasks.length,
    rpcRequiredReason: tasks.length > 0 ? "model-worker-required" : "no-tasks",
    deepseekCalls: 0,
    browserLaunches: false,
    reason: decision === DECISION.PARENT_DIRECT
      ? "parent-direct-minimal-effects"
      : writerCount === 0
        ? "read-only-no-worktrees"
        : "admitted-wave-effects",
  }

  // PACKING FOLLOWS THE DECISION (§2). The conflict authority may ALLOW a
  // parallel pack while the final decision is SERIAL (research barrier, run
  // budget refusal, economy clamp). A multi-scope `safe` row executes in
  // parallel downstream regardless of the decision, so a non-PARALLEL wave is
  // re-packed here into single-scope rows: every downstream consumer then
  // executes it serially BY STRUCTURE, not by cooperation. PARALLEL waves keep
  // the conflict authority's verbatim packing (positional `indexes` into the
  // caller's scope array, executable WITHOUT a second classifier).
  const decisionIsParallel = decision === DECISION.PARALLEL
  const packedConflictWaves = Object.freeze((conflict.waves || []).flatMap((row) => {
    const rowIndexes = [...(row.indexes || [])]
    if (decisionIsParallel || rowIndexes.length <= 1) {
      return [Object.freeze({
        wave: row.wave,
        indexes: Object.freeze(rowIndexes),
        scopes: Object.freeze([...(row.scopes || [])]),
        safe: row.safe === true,
        parallelClasses: Object.freeze([...(row.parallelClasses || [])]),
      })]
    }
    return rowIndexes.map((index, slot) => Object.freeze({
      wave: `${row.wave}.${slot}`,
      indexes: Object.freeze([index]),
      scopes: Object.freeze([(row.scopes || [])[slot] ?? String(scopes[index]?.id || "")]),
      safe: false,
      parallelClasses: Object.freeze([String((row.parallelClasses || [])[0] || "")]),
    }))
  }))

  return Object.freeze({
    waveIndex,
    taskIds: Object.freeze(tasks.map((task) => String(task?.id || ""))),
    decision,
    posture: economy?.posture || "SERIAL_STRUCTURED",
    parentDirect,
    spawnsChildren,
    spawnsWriters,
    // The full economy decision this verdict was composed from (frozen).
    // Telemetry and audits read it here; no second policy is consulted.
    economy: economy ? Object.freeze(economy) : null,
    // Only a PARALLEL decision carries a concurrency bound (see above);
    // SERIAL and PARENT_DIRECT are 1 by construction, including a budget
    // downgrade after the reservation refused full admission.
    concurrency: effectiveConcurrency,
    conflictWaves: packedConflictWaves,
    conflictDecision: conflict.decision || null,
    conflictBlocks: Object.freeze([...(conflict.blocks || [])]),
    reservation,
    verification: Object.freeze({ required: true, intact: true }),
    admission: Object.freeze({ ...admission }),
    canProduceVerdict: false,
    deterministic: true,
  })
}

export function compileExecutionPlan(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const taskById = new Map(tasks.map((task) => [String(task?.id || ""), task]))
  const maxConcurrency = Math.max(1, Math.trunc(Number(input.maxConcurrency) || 1))
  const generation = input.workspaceGeneration && typeof input.workspaceGeneration === "object"
    ? { ...input.workspaceGeneration }
    : { rootHead: null }
  const context = {
    maxConcurrency,
    maxWriters: Math.max(1, Math.trunc(Number(input.maxWriters) || maxConcurrency)),
    riskOf: input.riskOf,
    readOnlyWorkUseful: input.readOnlyWorkUseful,
    unresolvedResearch: input.unresolvedResearch,
    resourcePressure: input.resourcePressure,
    finalRelease: input.finalRelease,
    // V16.17 (§6): the critical-path history is an OBJECT the policy reads
    // (`history.components[name]`). A caller may pass either the resolved
    // object or a supplier; resolve a supplier EXACTLY ONCE here so the
    // MEASURED component provenance actually reaches `decideParallelExecution`
    // instead of silently falling back to ESTIMATED.
    history: (() => {
      const supplied = input.history
      if (typeof supplied === "function") {
        try {
          return supplied() || null
        } catch {
          return null
        }
      }
      return supplied || null
    })(),
    requestedReadOnly: input.requestedReadOnly,
    reserve: input.reserve,
  }
  const safeResult = computeSafeWaves({
    schemaVersion: 1,
    goal: String(input.goal || ""),
    tasks,
  })
  const orderedWaves = safeResult.waves || []
  const orderSerialized = Object.freeze((safeResult.serialized || []).map((row) => Object.freeze({
    task: String(row?.task || ""),
    conflictsWith: String(row?.conflictsWith || ""),
    reason: String(row?.reason || ""),
  })))
  const waves = orderedWaves.map((ids, waveIndex) => compileWave({
    waveIndex,
    tasks: (ids || []).map((id) => taskById.get(String(id))).filter(Boolean),
    context,
  }))
  const planId = "plan-" + createHash("sha256")
    .update(JSON.stringify([
      tasks.map((task) => String(task?.id || "")),
      generation.rootHead || "",
      String(input.runId || ""),
      maxConcurrency,
    ]), "utf8")
    .digest("hex")
    .slice(0, 16)
  const effectiveConcurrency = waves.reduce(
    (peak, wave) => Math.max(peak, wave.concurrency),
    waves.length ? 1 : 0,
  )
  return Object.freeze({
    schemaVersion: EXECUTION_PLAN_COMPILER_SCHEMA_VERSION,
    policy: EXECUTION_PLAN_COMPILER_POLICY,
    planId,
    runId: String(input.runId || ""),
    // The root generation this plan was compiled against. Staging and
    // integration re-check it before any aggregate mutation lands.
    generation: Object.freeze({ ...generation }),
    waves: Object.freeze(waves),
    // Tasks the order authority serialized (declared write/read conflict or
    // unknown file scope). Same single `computeSafeWaves` result as `waves`:
    // order and serialization are never re-derived downstream.
    serialized: orderSerialized,
    effectiveConcurrency,
    // V16.17 (§4 HONESTY): the runtime integration authority
    // (`lib/integration-transaction-v16-15.mjs`) applies each child patch to
    // the LIVE root in deterministic order and reverses every applied patch on
    // failure. It is transactional and ordered, but it is NOT staging-first:
    // there is no transaction-owned staging worktree and no single aggregate
    // root mutation. The mode name must say what the runtime actually does, so
    // this label reports the real mechanism rather than a claim the executor
    // does not implement.
    integrationMode: waves.some((wave) => wave.decision === DECISION.PARALLEL)
      ? "transactional-direct-multi-writer"
      : "direct-sequential",
    integrationStagingFirst: false,
    verificationRequirements: Object.freeze(
      Array.isArray(input.verificationRequirements) && input.verificationRequirements.length
        ? [...input.verificationRequirements]
        : ["local-verifier-pass"],
    ),
    canProduceVerdict: false,
    deterministic: true,
  })
}
