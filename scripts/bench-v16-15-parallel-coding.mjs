// V16.15 SINGLE-SHOT PARALLEL CODING BENCHMARK.
//
// HONESTY CONTRACT (inherited from V16.12/V16.13/V16.14, NOT weakened):
//
//   1. MEASURED means a real wall-clock observation of real code on this machine.
//   2. SIMULATED means a deterministic model of a decision, with no claim about
//      wall time at all. A simulated cell reports COUNTS, never milliseconds.
//   3. SYNTHETIC means a synthetic repository/scope set, with the real modules
//      under test. It is labelled per cell.
//   4. LIVE means a real child process and/or a real Git repository. It is only
//      used where a real process/tree is genuinely needed, and it is labelled.
//   5. PROVIDER TOKENS ARE NEVER REPORTED. This bench never talks to a provider,
//      so every token figure is NOT_MEASURED and the report says so.
//   6. THERE IS NO COMBINED SPEEDUP NUMBER. Cells are per scenario. The one
//      serial-vs-parallel cell is a real MEASURED pair and reports BOTH arms
//      separately plus the observed ratio for THAT cell only. It is never summed
//      into a headline figure, and it is meaningless on a single-core host.
//   7. A cell that cannot be measured reports `ms: null`, never a fabricated 0.
//   8. A cell that declares an expectation is checked, and the report counts the
//      failures. A bench whose cells can fail silently proves nothing.
//
// Run: node scripts/bench-v16-15-parallel-coding.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import {
  EXECUTION_POSTURE,
  classifyTaskShapeV16_15,
  decideParallelExecution,
  estimateParallelEconomy,
  resolveWriterConcurrency,
} from "../lib/parallel-execution-policy-v16-15.mjs";
import {
  buildConflictGraph,
  classifyPair,
  normalizeScope,
  scopesAreIndependent,
} from "../lib/execution-conflict-graph-v16-15.mjs";
import {
  createChildDelta,
  createCompactHandoff,
  createWaveSharedSnapshot,
  waveContextAccounting,
} from "../lib/wave-shared-context-v16-15.mjs";
import {
  deterministicIntegrationOrder,
  evaluateCompletion,
  runIntegrationTransaction,
} from "../lib/integration-transaction-v16-15.mjs";
import { classifyScope, assessParallelSafety, PARALLEL_SAFETY } from "../lib/delegation-safety.mjs";
import { createTaskSandbox, removeTaskSandbox } from "../lib/worktree-sandbox.mjs";
import {
  PARALLEL_CODING_EFFICIENCY_KIND,
  waveTelemetryToEfficiencyEvents,
} from "../lib/parallel-coding-runtime-v16-15.mjs";
import { aggregateEfficiencyMetrics } from "../lib/efficiency-metrics-v16-10.mjs";
import { NOT_MEASURED } from "../lib/measurement-provenance.mjs";
import { LAZY_RUNTIME_MODULES, LAZY_RUNTIME_STACKS } from "../lib/lazy-runtime.mjs";

const PROVIDER_TOKENS = "NOT_MEASURED";

function tempRoot(prefix = "ues-bench-e15-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

async function timeIt(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms: Number(ms.toFixed(3)), value };
}

/**
 * A real git repository with a deterministic history, for the live cells.
 *
 * Returns `{ git, head }`. The repo pins `core.autocrlf=false` and `core.eol=lf`
 * because the host system git may set `core.autocrlf=true`, which would rewrite
 * line endings inside a worktree and make a patch that applies cleanly on one
 * host fail on another.
 */
function initRepo(root) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });
  git("init", "-q");
  git("config", "user.email", "bench@example.com");
  git("config", "user.name", "bench");
  git("config", "core.autocrlf", "false");
  git("config", "core.eol", "lf");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bench", version: "1.0.0" }, null, 2) + "\n", "utf8");
  mkdirSync(path.join(root, "lib"), { recursive: true });
  writeFileSync(path.join(root, "lib", "alpha.mjs"), "export const alpha = 1\n", "utf8");
  writeFileSync(path.join(root, "lib", "beta.mjs"), "export const beta = 1\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { git, head: git("rev-parse", "HEAD").trim() };
}

function writerScope(id, files, extra = {}) {
  return { id, taskId: id, readOnly: false, writeFiles: files, readFiles: [], ...extra };
}

function independentScopes(count) {
  return Array.from({ length: count }, (_, index) =>
    writerScope(`t${index + 1}`, [`pkg${index + 1}/src/index.ts`]));
}

// ---------------------------------------------------------------------------
// SIMULATED cells: decisions, no wall-time claim
// ---------------------------------------------------------------------------

function cellShapeClassification() {
  const cases = [
    ["TINY", { changedFiles: ["lib/one.mjs"], risk: "low" }],
    ["SMALL", { changedFiles: ["lib/a.mjs", "lib/b.mjs"], risk: "low" }],
    ["DECOMPOSABLE", { changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"], risk: "medium", scopes: independentScopes(2) }],
    ["COMPLEX", { changedFiles: ["a.mjs", "b.mjs"], risk: "high" }],
    ["RELEASE", { changedFiles: ["a.mjs"], finalRelease: true }],
  ];
  return cases.map(([expected, input]) => {
    const classification = classifyTaskShapeV16_15(input);
    return {
      name: `shape:${expected}`,
      provenance: "SIMULATED",
      expected,
      actual: classification.shape,
      correct: classification.shape === expected,
      ms: null,
    };
  });
}

function cellPostureDecisions() {
  const scenarios = [
    ["tiny-parent-direct", { changedFiles: ["lib/one.mjs"], scopes: [writerScope("t1", ["lib/one.mjs"])] }, EXECUTION_POSTURE.PARENT_DIRECT],
    ["two-independent-writers", { changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"], scopes: independentScopes(2), perChildWorkMs: 60_000 }, EXECUTION_POSTURE.PARALLEL_WRITERS],
    ["same-file-serial", { changedFiles: ["lib/a.mjs"], scopes: [writerScope("t1", ["lib/a.mjs"]), writerScope("t2", ["lib/a.mjs"])], perChildWorkMs: 60_000 }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["unknown-scope-serial", { changedFiles: ["lib/a.mjs"], scopes: [writerScope("t1", ["lib/a.mjs"]), { id: "silent" }], perChildWorkMs: 60_000 }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["release-serial", { changedFiles: ["a.ts", "b.ts"], scopes: independentScopes(2), finalRelease: true, perChildWorkMs: 60_000 }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["research-barrier", { changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"], scopes: independentScopes(2), unresolvedResearch: true, perChildWorkMs: 60_000 }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["resource-pressure", { changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"], scopes: independentScopes(2), perChildWorkMs: 60_000, resourcePressure: { level: "high" } }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["economy-gate", { changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"], scopes: independentScopes(2), perChildWorkMs: 100 }, EXECUTION_POSTURE.SERIAL_STRUCTURED],
    ["read-only-overlap", { changedFiles: ["lib/a.mjs", "lib/b.mjs"], scopes: [writerScope("t1", ["lib/a.mjs"]), { id: "r1", readOnly: true, readFiles: ["lib/b.mjs"] }], readOnlyWorkUseful: true }, EXECUTION_POSTURE.PARALLEL_READ_ONLY],
  ];
  return scenarios.map(([name, input, expected]) => {
    const decision = decideParallelExecution(input);
    return {
      name: `posture:${name}`,
      provenance: "SIMULATED",
      expected,
      actual: decision.posture,
      correct: decision.posture === expected,
      writerConcurrency: decision.writerConcurrency,
      // A wave decision is never a verdict.
      canProduceVerdict: decision.canProduceVerdict,
      ms: null,
    };
  });
}

function cellIndependenceRules() {
  const pairs = [
    ["same-exact-file", writerScope("a", ["lib/x.mjs"]), writerScope("b", ["lib/x.mjs"]), false],
    ["same-dir-different-files", writerScope("a", ["lib/x/a.mjs"]), writerScope("b", ["lib/x/b.mjs"]), true],
    ["different-packages", writerScope("a", ["p1/a.ts"]), writerScope("b", ["p2/b.ts"]), true],
    ["read-write-dependency", writerScope("a", ["lib/api.mjs"]), writerScope("b", ["lib/other.mjs"], { readFiles: ["lib/api.mjs"] }), false],
    ["shared-config-family", writerScope("a", ["tsconfig.json"]), writerScope("b", ["tsconfig.build.json"]), false],
    ["lockfile-vs-manifest", writerScope("a", ["package-lock.json"]), writerScope("b", ["package.json"]), false],
    ["unknown-scope", writerScope("a", []), writerScope("b", ["lib/b.mjs"]), false],
    ["unnormalizable-path", writerScope("a", ["../../etc/passwd"]), writerScope("b", ["lib/b.mjs"]), false],
    ["destructive-shell", writerScope("a", ["lib/a.mjs"], { task: "rm -rf lib" }), writerScope("b", ["lib/b.mjs"]), false],
    ["declared-module-edge", writerScope("a", ["lib/a.mjs"]), writerScope("b", ["lib/b.mjs"]), false, [{ from: "lib/a.mjs", to: "lib/b.mjs" }]],
  ];
  return pairs.map(([name, left, right, expected, moduleEdges]) => {
    const result = scopesAreIndependent(left, right, moduleEdges ? { moduleEdges } : {});
    return {
      name: `independence:${name}`,
      provenance: "SIMULATED",
      expectedIndependent: expected,
      actualIndependent: result.independent,
      correct: result.independent === expected,
      relations: result.kinds,
      ms: null,
    };
  });
}

function cellDelegationSafetyAgreement() {
  // The delegation-safety owner must give the SAME verdict as the conflict graph
  // for the same pair. Two owners disagreeing is the bug this release fixes.
  const scopes = [
    classifyScope({ childId: "a", role: "implement", readOnly: false, files: ["lib/x/a.mjs"], task: "edit a" }),
    classifyScope({ childId: "b", role: "implement", readOnly: false, files: ["lib/x/b.mjs"], task: "edit b" }),
  ];
  const assessment = assessParallelSafety(scopes);
  const graph = buildConflictGraph(
    scopes.map((scope, index) => ({
      id: `${scope.childId}#${index}`,
      readOnly: scope.writer !== true,
      ...(scope.writer === true ? { writeFiles: scope.files } : { readFiles: scope.files }),
    })),
    { maxParallel: 2 },
  );
  const delegationAllowed = assessment.decision === PARALLEL_SAFETY.ALLOWED;
  const graphAllowed = graph.edgeCount === 0;
  return [{
    name: "agreement:delegation-safety-vs-conflict-graph",
    provenance: "SIMULATED",
    graphEdgeCount: graph.edgeCount,
    delegationDecision: assessment.decision,
    delegationBlocked: !delegationAllowed,
    // Both owners must agree that two different files in one directory can run.
    agree: graphAllowed === delegationAllowed,
    correct: graphAllowed === true && delegationAllowed === true,
    ms: null,
  }];
}

function cellIsolatedWriteWidth() {
  const requested = [undefined, 1, 2, 3, 4, 99];
  return requested.map((value) => ({
    name: `writer-bound:requested-${value === undefined ? "default" : value}`,
    provenance: "SIMULATED",
    requested: value === undefined ? null : value,
    resolved: resolveWriterConcurrency(value),
    // The hard max is 3 on every platform; Windows' default is 2.
    withinHardMax: resolveWriterConcurrency(value) <= 3,
    ms: null,
  }));
}

function cellEconomyGate() {
  return [500, 4_000, 30_000, 300_000].map((perChildWorkMs) => {
    const economy = estimateParallelEconomy({ scopes: independentScopes(2), perChildWorkMs });
    return {
      name: `economy:per-child-${perChildWorkMs}ms`,
      provenance: "SIMULATED",
      perChildWorkMs,
      economical: economy.economical.value,
      estimatedOverlapSavingMs: economy.estimatedOverlapSavingMs.value,
      savingProvenance: economy.provenance.savings,
      tokenSavingClaim: economy.provenance.tokens,
      ms: null,
    };
  });
}

// ---------------------------------------------------------------------------
// SYNTHETIC cells: real modules, synthetic inputs
// ---------------------------------------------------------------------------

function cellSharedContextDedup() {
  const childCounts = [1, 2, 4];
  const cells = [];
  for (const count of childCounts) {
    const snapshot = createWaveSharedSnapshot({
      waveId: `w${count}`,
      goal: "Implement V16.15 single-shot parallel coding",
      constraints: ["no commit", "no publish", "no tag", "local verifier is the only PASS authority"],
      architecture: ["policy owns the decision", "conflict graph owns independence", "transaction owns integration"],
      requirementIds: ["R1", "R2", "R3", "R4", "R5"],
      sourceEvidence: ["evidence:sha256:a", "evidence:sha256:b"],
    });
    const deltas = Array.from({ length: count }, (_, index) => createChildDelta({
      snapshot,
      child: {
        childId: `c${index}`,
        taskId: `t${index}`,
        goal: `Task ${index}`,
        writeFiles: [`pkg${index}/src/index.ts`],
        acceptance: ["behavior verified"],
      },
    }));
    const accounting = waveContextAccounting({ snapshot, deltas });
    cells.push({
      name: `shared-context:${count}-child`,
      provenance: "SYNTHETIC",
      childCount: count,
      snapshotChars: snapshot.chars.value,
      childDeltaChars: accounting.childSpecificChars.value,
      totalWaveChars: accounting.totalWaveChars.value,
      naiveBaselineChars: accounting.naiveBaselineChars.value,
      duplicateContextCharsAvoided: accounting.duplicateContextCharsAvoided.value,
      charsProvenance: accounting.provenance.chars,
      tokensProvenance: accounting.provenance.tokens,
      tokenSavingClaim: accounting.tokenSavingClaim,
      // The law: no child delta repeats the shared block inline.
      sharedBlockRepeatedInline: deltas.some((delta) => String(delta.text || "").includes(snapshot.text)),
      ms: null,
    });
  }
  return cells;
}

function cellHandoffBounded() {
  const handoff = createCompactHandoff({
    child: {
      childId: "c1",
      taskId: "t1",
      status: "completed",
      changedFiles: Array.from({ length: 400 }, (_, index) => `lib/f${index}.mjs`),
      warnings: Array.from({ length: 100 }, (_, index) => `warning ${index} ${"x".repeat(300)}`),
      firstFailure: "f".repeat(50_000),
      verificationResults: [{ command: "node --test", status: "pass", exitCode: 0 }],
    },
  });
  return [{
    name: "handoff:bounded-receipt",
    provenance: "SYNTHETIC",
    changedFiles: handoff.changedFiles.length,
    warnings: handoff.warnings.length,
    firstFailureChars: handoff.firstFailure?.length ?? 0,
    // A 50k failure body must not survive into the parent context.
    firstFailureBounded: (handoff.firstFailure?.length ?? 0) <= 600,
    // Read from the RECEIPT, never asserted by the bench on the receipt's behalf.
    rawLogsInlined: handoff.rawLogsInline,
    // A receipt is evidence, never a verdict.
    canProduceVerdict: handoff.canProduceVerdict,
    correct: (handoff.firstFailure?.length ?? 0) <= 600
      && handoff.rawLogsInline === false
      && handoff.canProduceVerdict === false,
    ms: null,
  }];
}

function cellIntegrationOrderDeterminism() {
  const patches = [
    { taskId: "c", wave: 0, dependsOn: ["b"] },
    { taskId: "a", wave: 0 },
    { taskId: "b", wave: 0, dependsOn: ["a"] },
  ];
  const forward = deterministicIntegrationOrder(patches);
  const reverse = deterministicIntegrationOrder([...patches].reverse());
  const shuffled = deterministicIntegrationOrder([patches[1], patches[2], patches[0]]);
  const dependencyFirst = forward.order.indexOf("a") < forward.order.indexOf("b")
    && forward.order.indexOf("b") < forward.order.indexOf("c");
  const stableAcrossInputOrder = JSON.stringify(forward.order) === JSON.stringify(reverse.order)
    && JSON.stringify(forward.order) === JSON.stringify(shuffled.order);
  return [{
    name: "integration:deterministic-order",
    provenance: "SYNTHETIC",
    order: forward.order,
    dependencyFirst,
    stableAcrossInputOrder,
    completionOrderIgnored: forward.completionOrderIgnored,
    correct: dependencyFirst && stableAcrossInputOrder && forward.completionOrderIgnored === true,
    ms: null,
  }];
}

function cellCompletionStates() {
  const scenarios = [
    ["done", { verificationPassed: true, workspaceStable: true, completionAuditPassed: true, pendingTasks: 0 }, "DONE"],
    ["blocked-by-blocker", { verificationPassed: true, blockers: ["dependency missing"] }, "BLOCKED"],
    ["needs-user-decision", { verificationPassed: false, userDecisionReason: "external-publish-approval" }, "NEEDS_USER_DECISION"],
    ["unrecognized-reason-blocks", { verificationPassed: false, userDecisionReason: "i-want-to-stop" }, "BLOCKED"],
    ["cancelled", { cancelled: true }, "CANCELLED"],
    ["continue-unverified", { verificationPassed: false }, "CONTINUE"],
  ];
  return scenarios.map(([name, input, expected]) => {
    const decision = evaluateCompletion(input);
    return {
      name: `completion:${name}`,
      provenance: "SYNTHETIC",
      expected,
      state: decision.state,
      correct: decision.state === expected,
      ms: null,
    };
  });
}

function cellMetricsProducerHonesty() {
  const events = waveTelemetryToEfficiencyEvents({
    waves: [
      { posture: "PARALLEL_WRITERS", reason: ["independent-writers"] },
      { posture: "PARENT_DIRECT", reason: ["parent-direct-shape"] },
      { posture: "SERIAL_STRUCTURED", reason: ["writer-conflict"] },
    ],
    sharedContext: [{ snapshotChars: 2_000, accounting: { duplicateContextCharsAvoided: { value: 6_000 } } }],
    integrationTransactions: [{ outcome: "integrated", rootUnchanged: false }],
  });
  const metrics = aggregateEfficiencyMetrics(events, []);
  return [{
    name: "metrics:producer-honesty",
    provenance: "SYNTHETIC",
    emittedKind: PARALLEL_CODING_EFFICIENCY_KIND,
    observations: events.length,
    allCountsMeasured: events.every((row) => row.provenance.count === "MEASURED"),
    speedupClaim: metrics.parallelCoding.speedupClaim,
    overlapSavingProvenance: metrics.parallelCoding.measuredOverlapSavedMs.provenance,
    // No breakdown event may be emitted for a category that never occurred.
    noZeroCountObservations: events.every((row) => Number(row.metrics.count) > 0),
    correct: events.every((row) => row.provenance.count === "MEASURED" && Number(row.metrics.count) > 0)
      && metrics.parallelCoding.speedupClaim === null
      && metrics.parallelCoding.measuredOverlapSavedMs.provenance === NOT_MEASURED.provenance,
    ms: null,
  }];
}

function cellColdStartLazy() {
  // A pure decision must not require the wave context or the transaction. The
  // stack is proven by loading it explicitly, one owner at a time.
  const scope = normalizeScope({ id: "t1", readOnly: false, writeFiles: ["lib/one.mjs"] });
  const pair = classifyPair(scope, normalizeScope({ id: "t2", readOnly: false, writeFiles: ["lib/two.mjs"] }));
  return [{
    name: "cold-start:decision-needs-no-hydration",
    provenance: "SYNTHETIC",
    pairVerdict: pair.verdict,
    graphEdgeCount: buildConflictGraph([
      { id: "t1", readOnly: false, writeFiles: ["lib/one.mjs"] },
      { id: "t2", readOnly: false, writeFiles: ["lib/two.mjs"] },
    ], { maxParallel: 2 }).edgeCount,
    // The V16.15 stack is REGISTERED lazily; the wiring suite proves `ues.ts`
    // never imports it statically. This records the registry contract.
    stackSize: LAZY_RUNTIME_STACKS.PARALLEL_CODING.length,
    stackMembers: [...LAZY_RUNTIME_STACKS.PARALLEL_CODING],
    ms: null,
  }];
}

// ---------------------------------------------------------------------------
// MEASURED cell: a real serial-vs-parallel wall comparison on real worktrees
// ---------------------------------------------------------------------------

const CPU_WORK_MS = 700;
const CPU_WORK_SCRIPT = "const deadline=Date.now()+CPU_MS;let a=0;while(Date.now()<deadline){for(let i=0;i<20000;i+=1)a=(a*31+i)%1000000007;}"
  .replace("CPU_MS", String(CPU_WORK_MS));

/**
 * The ONLY cell that makes a wall-time statement. BOTH arms run the SAME real
 * child process doing the SAME deterministic CPU work in REAL git worktrees on
 * this machine, so the only difference between the arms is overlap. Both arms are
 * reported separately, and the ratio belongs to THIS cell only: it is never
 * summed with anything, and on a single-core host it is not a speedup at all.
 *
 * The work is deliberately deterministic CPU work (a hash loop), not a model
 * call, so the comparison isolates the parallelism and nothing else.
 */
async function cellSerialVsParallelWriters() {
  const root = tempRoot("ues-bench-e15-serial-parallel-");
  const sandboxes = [];
  const taskCount = 2;
  const cpuCount = availableParallelism();
  try {
    const { git, head } = initRepo(root);

    // Create the worktrees ONCE so tree creation is not part of either arm, and
    // edit a TRACKED file in each so the patch is visible to `git diff HEAD`.
    for (let index = 0; index < taskCount; index += 1) {
      const sandbox = await createTaskSandbox(root, `bench-${index}`, `t${index + 1}`);
      sandboxes.push(sandbox);
      const file = index === 0 ? "lib/alpha.mjs" : "lib/beta.mjs";
      writeFileSync(path.join(sandbox.dir, file), `export const value = ${index}\n`, "utf8");
    }

    // One real child process per task. Identical in both arms.
    const runWorker = (cwd) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", CPU_WORK_SCRIPT], { cwd, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cpu worker exited with ${code}`))));
    });

    // ARM 1: serial. The second task does not start until the first finishes.
    const serial = await timeIt(async () => {
      for (const sandbox of sandboxes) await runWorker(sandbox.dir);
      return taskCount;
    });

    // ARM 2: parallel. Both tasks overlap; the wall time is the longest task.
    const parallel = await timeIt(async () => {
      await Promise.all(sandboxes.map((sandbox) => runWorker(sandbox.dir)));
      return taskCount;
    });

    // Patch generation happens OUTSIDE both timed windows, so neither arm is
    // charged for it. It is only here to prove both arms did REAL work.
    const patches = sandboxes.map((sandbox) => execFileSync("git", ["diff", "--binary", "--no-ext-diff", head, "--"], {
      cwd: sandbox.dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    }));
    const realWorkProduced = patches.every((patch) => patch.trim().length > 0);
    const observedRatio = parallel.ms > 0 ? Number((serial.ms / parallel.ms).toFixed(3)) : null;

    return [{
      name: "measured:serial-vs-parallel-writers",
      provenance: "MEASURED",
      taskCount,
      cpuWorkMsPerTask: CPU_WORK_MS,
      cpuCount,
      serialWallMs: serial.ms,
      parallelWallMs: parallel.ms,
      observedRatio,
      // The ratio is a fact about THIS cell on THIS machine, with THIS core count.
      // It is not a claim about any other workload, and it is not summed.
      ratioScope: "this-cell-this-machine-only",
      ratioMeaningful: cpuCount >= taskCount,
      bothArmsProducedRealPatches: realWorkProduced,
      liveProcesses: true,
      correct: realWorkProduced,
      providerTokens: PROVIDER_TOKENS,
    }];
  } catch (error) {
    return [{
      name: "measured:serial-vs-parallel-writers",
      provenance: "MEASURED",
      outcome: "bench-error",
      error: error instanceof Error ? error.message : String(error),
      ms: null,
      correct: false,
      providerTokens: PROVIDER_TOKENS,
    }];
  } finally {
    for (const sandbox of sandboxes) {
      await removeTaskSandbox(root, sandbox.dir, { force: true, deleteBranch: true }).catch(() => {});
    }
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// LIVE cells: real transactional integration against a real git root
// ---------------------------------------------------------------------------

async function cellTransactionalIntegrationLive() {
  const root = tempRoot("ues-bench-e15-integration-");
  const sandboxes = [];
  const cells = [];
  const track = async (slug, taskId, options) => {
    const sandbox = await createTaskSandbox(root, slug, taskId, options);
    sandboxes.push(sandbox);
    return sandbox;
  };
  try {
    initRepo(root);

    // --- CELL 1: a clean two-writer transaction really applies both patches. ---
    const alpha = await track("bench-alpha", "t1");
    const beta = await track("bench-beta", "t2");
    writeFileSync(path.join(alpha.dir, "lib", "alpha.mjs"), "export const alpha = 42\n", "utf8");
    writeFileSync(path.join(beta.dir, "lib", "beta.mjs"), "export const beta = 42\n", "utf8");

    const clean = await timeIt(() => runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t1", sandboxDir: alpha.dir, writeFiles: ["lib/alpha.mjs"] },
        { taskId: "t2", sandboxDir: beta.dir, writeFiles: ["lib/beta.mjs"] },
      ],
    }));
    const alphaApplied = readFileSync(path.join(root, "lib", "alpha.mjs"), "utf8").includes("42");
    const betaApplied = readFileSync(path.join(root, "lib", "beta.mjs"), "utf8").includes("42");
    cells.push({
      name: "live:transaction-integrated",
      provenance: "LIVE",
      outcome: clean.value.outcome,
      appliedCount: clean.value.applied.length,
      alphaApplied,
      betaApplied,
      rootIdentityChanged: clean.value.rootIdentityChanged,
      // Integration NEVER asserts PASS; only the local verifier can.
      canProduceVerdict: clean.value.canProduceVerdict,
      ms: clean.ms,
      correct: clean.value.outcome === "integrated" && alphaApplied && betaApplied
        && clean.value.canProduceVerdict === false,
      providerTokens: PROVIDER_TOKENS,
    });

    // The root is dirty from CELL 1 now, so later sandboxes inherit that snapshot.
    const inherit = { inheritDirtyRoot: true };

    // --- CELL 2: two patches that rewrite the SAME file are refused in preflight. ---
    const dupOne = await track("bench-dup-one", "t3", inherit);
    const dupTwo = await track("bench-dup-two", "t4", inherit);
    writeFileSync(path.join(dupOne.dir, "lib", "beta.mjs"), "export const beta = 43\n", "utf8");
    writeFileSync(path.join(dupTwo.dir, "lib", "beta.mjs"), "export const beta = 44\n", "utf8");
    const betaBeforeCollision = readFileSync(path.join(root, "lib", "beta.mjs"), "utf8");
    const collision = await timeIt(() => runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t3", sandboxDir: dupOne.dir, writeFiles: ["lib/beta.mjs"] },
        { taskId: "t4", sandboxDir: dupTwo.dir, writeFiles: ["lib/beta.mjs"] },
      ],
    }));
    cells.push({
      name: "live:transaction-refused-before-mutation",
      provenance: "LIVE",
      outcome: collision.value.outcome,
      collisionCount: (collision.value.collisions || []).length,
      appliedCount: collision.value.applied.length,
      // The whole point: the root is untouched, because nothing was applied.
      rootUnchanged: collision.value.rootUnchanged === true,
      betaStillUnchanged: readFileSync(path.join(root, "lib", "beta.mjs"), "utf8") === betaBeforeCollision,
      canProduceVerdict: collision.value.canProduceVerdict,
      ms: collision.ms,
      correct: collision.value.outcome === "preflight-rejected"
        && (collision.value.collisions || []).length > 0
        && collision.value.applied.length === 0
        && collision.value.rootUnchanged === true
        && readFileSync(path.join(root, "lib", "beta.mjs"), "utf8") === betaBeforeCollision,
      providerTokens: PROVIDER_TOKENS,
    });

    // --- CELL 3: a REAL apply failure after a REAL apply, then a REAL rollback. ---
    // Both patches preflight cleanly against the current root (the collision is
    // structural, not textual): t5 creates `lib/x/a.mjs`, t6 creates the FILE
    // `lib/x`. Only the second can fail, and it fails at APPLY, which is exactly
    // the case the transaction's rollback exists for.
    const gamma = await track("bench-gamma", "t5", inherit);
    const delta = await track("bench-delta", "t6", inherit);
    mkdirSync(path.join(gamma.dir, "lib", "x"), { recursive: true });
    writeFileSync(path.join(gamma.dir, "lib", "x", "a.mjs"), "export const xa = 1\n", "utf8");
    writeFileSync(path.join(delta.dir, "lib", "x"), "this path must be a file, not a directory\n", "utf8");
    const identityBefore = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root, encoding: "utf8",
    });
    const failing = await timeIt(() => runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t5", sandboxDir: gamma.dir, writeFiles: ["lib/x/a.mjs"] },
        { taskId: "t6", sandboxDir: delta.dir, writeFiles: ["lib/x"] },
      ],
    }));
    const identityAfter = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root, encoding: "utf8",
    });
    cells.push({
      name: "live:transaction-apply-failed-then-rolled-back",
      provenance: "LIVE",
      outcome: failing.value.outcome,
      // t5 applied and was then reversed; t6 never applied.
      appliedBeforeRollback: failing.value.applied.length,
      rolledBack: (failing.value.rollback || []).filter((row) => row.rolledBack === true).length,
      rejectedReason: (failing.value.rejected || [])[0]?.reason ?? null,
      rootUnchanged: failing.value.rootUnchanged === true,
      workspaceByteIdentical: identityBefore === identityAfter,
      canProduceVerdict: failing.value.canProduceVerdict,
      ms: failing.ms,
      correct: failing.value.outcome === "apply-failed-rolled-back"
        && failing.value.rootUnchanged === true
        && identityBefore === identityAfter
        && failing.value.applied.length > 0
        && (failing.value.rollback || []).some((row) => row.rolledBack === true),
      providerTokens: PROVIDER_TOKENS,
    });
    return cells;
  } catch (error) {
    cells.push({
      name: "live:transaction-error",
      provenance: "LIVE",
      outcome: "bench-error",
      error: error instanceof Error ? error.message : String(error),
      ms: null,
      correct: false,
      providerTokens: PROVIDER_TOKENS,
    });
    return cells;
  } finally {
    for (const sandbox of sandboxes) {
      await removeTaskSandbox(root, sandbox.dir, { force: true, deleteBranch: true }).catch(() => {});
    }
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function main() {
  const cells = [];
  cells.push(...cellShapeClassification());
  cells.push(...cellPostureDecisions());
  cells.push(...cellIndependenceRules());
  cells.push(...cellDelegationSafetyAgreement());
  cells.push(...cellIsolatedWriteWidth());
  cells.push(...cellEconomyGate());
  cells.push(...cellSharedContextDedup());
  cells.push(...cellHandoffBounded());
  cells.push(...cellIntegrationOrderDeterminism());
  cells.push(...cellCompletionStates());
  cells.push(...cellMetricsProducerHonesty());
  cells.push(...cellColdStartLazy());
  cells.push(...(await cellSerialVsParallelWriters()));
  cells.push(...(await cellTransactionalIntegrationLive()));

  const byProvenance = cells.reduce((acc, cell) => {
    acc[cell.provenance] = (acc[cell.provenance] || 0) + 1;
    return acc;
  }, {});

  const checked = cells.filter((cell) => typeof cell.correct === "boolean");
  const failed = checked.filter((cell) => cell.correct !== true);

  const report = {
    policy: "bench-v16-15-parallel-coding",
    release: "16.15.0",
    // Provenance vocabulary. Every cell declares exactly one.
    provenanceVocabulary: ["SIMULATED", "SYNTHETIC", "MEASURED", "LIVE"],
    cellsByProvenance: byProvenance,
    cellCount: cells.length,
    checkedCells: checked.length,
    failedCells: failed.length,
    failedCellNames: failed.map((cell) => cell.name),
    providerTokens: PROVIDER_TOKENS,
    providerTokensProvenance: NOT_MEASURED.provenance,
    providerTokensReason: "this bench never contacts a provider; a provider token count cannot be measured here",
    // The honesty law this release must not break.
    summedSpeedupClaim: null,
    summedSpeedupReason: "cells are per-scenario and are never summed; the only ratio is scoped to its own cell",
    tokenSavingClaim: null,
    qualityClaim: "NOT_INFERRED_FROM_BENCH",
    cells,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

export { main };

const isMain = Boolean(process.argv[1]) && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  main().then((report) => {
    // A failed cell is a real finding: exit non-zero so CI cannot ignore it.
    if (report.failedCells > 0) process.exit(1);
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
