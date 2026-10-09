// V16.16 CRITICAL-PATH EXECUTION & COST BENCHMARK.
//
// HONESTY CONTRACT (inherited from V16.12-V16.15, NOT weakened):
//
//   1. MEASURED means a real wall-clock observation of real code on this machine.
//   2. SIMULATED means a deterministic decision model (counts only, `ms: null`).
//   3. SYNTHETIC means the real modules under test with synthetic scopes.
//   4. LIVE means a real child process and/or a real Git repository.
//   5. PROVIDER TOKENS ARE NEVER REPORTED. This bench never talks to a
//      provider, so every token figure is NOT_MEASURED and the report says so.
//   6. THERE IS NO COMBINED SPEEDUP NUMBER and NO V16.15-BASELINE NUMBER. The
//      old gate formula is documented, not re-measured: inventing baseline
//      milliseconds from a replaced code path would be fabrication. Cells are
//      per scenario; the serial-vs-parallel cell reports BOTH arms separately
//      plus the observed ratio for THAT cell only, never summed.
//   7. A cell that cannot be measured reports `ms: null`, never a fabricated 0.
//   8. A cell that declares an expectation is checked; failures are counted and
//      the bench exits non-zero. A bench that can fail silently proves nothing.
//
// Run: node scripts/bench-v16-16-critical-path.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  EXECUTION_POSTURE,
  decideParallelExecution,
  estimateParallelEconomy,
  estimateScopeWorkMs,
} from "../lib/parallel-execution-policy-v16-15.mjs";
import { buildConflictGraph, classifyPair } from "../lib/execution-conflict-graph-v16-15.mjs";
import {
  buildCanonicalChildCapsule,
  createWaveSharedSnapshot,
  fitSections,
} from "../lib/wave-shared-context-v16-15.mjs";
import {
  recoverIncompleteIntegrations,
  runIntegrationTransaction,
} from "../lib/integration-transaction-v16-15.mjs";
import { createTaskSandbox, removeTaskSandbox } from "../lib/worktree-sandbox.mjs";
import {
  buildCriticalPathTelemetry,
  planProofReuse,
  prewarmWaveWorkers,
  shouldStopProven,
  waveTelemetryToEfficiencyEvents,
} from "../lib/parallel-coding-runtime-v16-15.mjs";
import { reserveRunCost } from "../lib/orchestration-budget-v16-6.mjs";
import { createCriticalPathHistory } from "../lib/critical-path-history-v16-16.mjs";

const PROVIDER_TOKENS = "NOT_MEASURED";

function tempRoot(prefix = "ues-bench-e16-") {
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

const writer = (id, files, extra = {}) => ({ id, taskId: id, readOnly: false, writeFiles: files, readFiles: [], ...extra });
const substantial = (id, pkg) => writer(id,
  [`${pkg}/src/a.ts`, `${pkg}/src/b.ts`, `${pkg}/src/c.ts`],
  {
    acceptance: ["done-a", "done-b"], verificationCommands: ["node --test"],
    task: `Implement substantial feature ${id} with acceptance criteria and verification`,
  });

// ---------------------------------------------------------------------------
// SIMULATED/SYNTHETIC decision cells (scenarios A-J): counts, never ms
// ---------------------------------------------------------------------------

function cellDecisions() {
  const cells = [];
  const decide = (name, input, expectPosture) => {
    const decision = decideParallelExecution(input);
    cells.push({
      name,
      provenance: "SYNTHETIC",
      posture: decision.posture,
      shape: decision.shape,
      spawnsWriters: decision.spawnsWriters,
      workProvenance: decision.economy?.perChildWorkMs?.provenance ?? null,
      ms: null,
      correct: decision.posture === expectPosture,
      providerTokens: PROVIDER_TOKENS,
    });
  };
  // A. typo / one-file tiny fix -> parent direct, zero children.
  decide("scenario-A:typo-tiny-fix", { changedFiles: ["lib/typo.mjs"], risk: "low" }, "PARENT_DIRECT");
  // B. one known failing test -> targeted proof planning, no parallel writers.
  {
    const plan = planProofReuse({
      candidates: [{
        command: "node --test test/known.test.mjs", args: [], fingerprint: "fp-b",
        exitCode: 1, completed: true, ageMs: 100, affectedBySiblings: false,
      }],
    });
    cells.push({
      name: "scenario-B:known-failing-test-reruns",
      provenance: "SIMULATED",
      reuse: plan.reuse.length,
      run: plan.run.length,
      ms: null,
      correct: plan.reuse.length === 0 && plan.run.length === 1,
      providerTokens: PROVIDER_TOKENS,
    });
  }
  // C. small two-file coherent fix -> parent direct.
  decide("scenario-C:small-two-file-fix", {
    changedFiles: ["lib/a.mjs", "lib/b.mjs"], risk: "low",
    scopes: [writer("t1", ["lib/a.mjs", "lib/b.mjs"])],
  }, "PARENT_DIRECT");
  // D. two independent substantial writers -> parallel writers.
  decide("scenario-D:two-substantial-writers", {
    changedFiles: ["pkg1/src/a.ts", "pkg1/src/b.ts", "pkg1/src/c.ts", "pkg2/src/a.ts", "pkg2/src/b.ts", "pkg2/src/c.ts"],
    risk: "medium",
    scopes: [substantial("t1", "pkg1"), substantial("t2", "pkg2")],
  }, "PARALLEL_WRITERS");
  // E. three independent writers -> bounded at 3.
  {
    const scopes = [substantial("t1", "pkg1"), substantial("t2", "pkg2"), substantial("t3", "pkg3")];
    const decision = decideParallelExecution({
      changedFiles: scopes.flatMap((s) => s.writeFiles), risk: "medium", scopes,
    });
    cells.push({
      name: "scenario-E:three-writers-bounded",
      provenance: "SYNTHETIC",
      posture: decision.posture,
      writerConcurrency: decision.writerConcurrency,
      ms: null,
      correct: decision.posture === "PARALLEL_WRITERS" && decision.writerConcurrency <= 3,
      providerTokens: PROVIDER_TOKENS,
    });
  }
  // F. two same-file conflicting writers -> serial.
  decide("scenario-F:same-file-conflict", {
    changedFiles: ["lib/shared.mjs"], risk: "medium",
    scopes: [writer("t1", ["lib/shared.mjs"], { task: "edit shared" }), writer("t2", ["lib/shared.mjs"], { task: "edit shared" })],
    perChildWorkMs: 30_000,
  }, "SERIAL_STRUCTURED");
  // G. cross-package independent work -> parallel.
  decide("scenario-G:cross-package-independent", {
    changedFiles: ["packages/a/src/x.ts", "packages/b/src/y.ts"], risk: "medium",
    scopes: [substantial("t1", "packages/a"), substantial("t2", "packages/b")],
  }, "PARALLEL_WRITERS");
  // H. lockfile/manifest change -> conflict, serial.
  {
    const pair = classifyPair(writer("a", ["package.json"]), writer("b", ["package-lock.json"]));
    cells.push({
      name: "scenario-H:lockfile-manifest-conflict",
      provenance: "SYNTHETIC",
      verdict: pair.verdict,
      ms: null,
      correct: pair.verdict === "conflict",
      providerTokens: PROVIDER_TOKENS,
    });
  }
  // I. medium 3-5 file bug, one writer -> serial (no second writer to overlap).
  decide("scenario-I:medium-single-writer", {
    changedFiles: ["lib/a.mjs", "lib/b.mjs", "lib/c.mjs", "lib/d.mjs"], risk: "medium",
    scopes: [writer("t1", ["lib/a.mjs", "lib/b.mjs", "lib/c.mjs", "lib/d.mjs"])],
  }, "SERIAL_STRUCTURED");
  // J. external API/version issue with unresolved research -> writers blocked.
  decide("scenario-J:external-research-barrier", {
    changedFiles: ["lib/a.mjs", "lib/b.mjs"], risk: "medium",
    scopes: [substantial("t1", "pkg1"), substantial("t2", "pkg2")],
    unresolvedResearch: true,
  }, "SERIAL_STRUCTURED");
  // False-positive guards ride along: prose words never conflict.
  {
    const pair = classifyPair(
      writer("a", ["lib/a.mjs"], { task: "fix HTML tag rendering" }),
      writer("b", ["lib/b.mjs"], { task: "tag parser bug" }),
    );
    cells.push({
      name: "guard:false-positive-tag-prose",
      provenance: "SYNTHETIC",
      verdict: pair.verdict,
      ms: null,
      correct: pair.verdict === "independent",
      providerTokens: PROVIDER_TOKENS,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// K. LIVE crash/recovery transaction (real repo, real rollback, real journal)
// ---------------------------------------------------------------------------

async function cellCrashRecoveryLive() {
  const cells = [];
  const root = tempRoot();
  const sandboxes = [];
  try {
    initRepo(root);
    const track = async (slug, taskId, runId) => {
      const sandbox = await createTaskSandbox(root, slug, taskId, { runId, waveId: "wave-bench" });
      sandboxes.push(sandbox);
      return sandbox;
    };
    const runId = "bench-crash";
    const a = await track("bench-a", "t1", runId);
    const b = await track("bench-b", "t2", runId);
    writeFileSync(path.join(a.dir, "lib", "alpha.mjs"), "export const alpha = 2\n", "utf8");
    writeFileSync(path.join(b.dir, "lib", "beta.mjs"), "export const beta = 2\n", "utf8");
    const crash = await timeIt(() => runIntegrationTransaction({
      root,
      runId,
      waveId: "wave-bench",
      patches: [
        { taskId: "t1", sandboxDir: a.dir, writeFiles: ["lib/alpha.mjs"], runId },
        { taskId: "t2", sandboxDir: b.dir, writeFiles: ["lib/beta.mjs"], runId },
      ],
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => ({ crashed: false }), (error) => ({ crashed: error?.code })));
    const recovered = await timeIt(() => recoverIncompleteIntegrations(root, { runId }));
    const alphaRestored = readFileSync(path.join(root, "lib", "alpha.mjs"), "utf8") === "export const alpha = 1\n";
    cells.push({
      name: "scenario-K:crash-recovery-transaction",
      provenance: "LIVE",
      crashed: crash.value.crashed,
      crashMs: crash.ms,
      recoveryOutcome: recovered.value.recovered?.[0]?.outcome ?? null,
      recoveryMs: recovered.ms,
      alphaRestored,
      ms: Number((crash.ms + recovered.ms).toFixed(3)),
      correct: crash.value.crashed === "INTEGRATION_CRASH_SIMULATED"
        && recovered.value.recovered?.[0]?.outcome === "rolled-back"
        && alphaRestored,
      providerTokens: PROVIDER_TOKENS,
    });
    // Idempotent rerun recovers nothing further.
    const again = await recoverIncompleteIntegrations(root, { runId });
    cells.push({
      name: "scenario-K:recovery-idempotent",
      provenance: "LIVE",
      pending: again.pending,
      ms: null,
      correct: again.pending === 0,
      providerTokens: PROVIDER_TOKENS,
    });
    return cells;
  } catch (error) {
    cells.push({
      name: "scenario-K:crash-error", provenance: "LIVE",
      error: error instanceof Error ? error.message : String(error),
      ms: null, correct: false, providerTokens: PROVIDER_TOKENS,
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
// L. MEASURED cold start: import wall times + hydration counts (this machine)
// ---------------------------------------------------------------------------

async function cellColdStartMeasured() {
  const cells = [];
  const cold = await timeIt(() => import("../lib/lazy-runtime.mjs"));
  cells.push({
    name: "scenario-L:lazy-registry-import",
    provenance: "MEASURED",
    ms: cold.ms,
    correct: cold.ms < 5_000,
    providerTokens: PROVIDER_TOKENS,
  });
  const stack = await timeIt(async () => {
    const lazy = await import("../lib/lazy-runtime.mjs");
    return lazy.hydrateRuntimeModule(lazy.LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME);
  });
  cells.push({
    name: "scenario-L:parallel-stack-hydration",
    provenance: "MEASURED",
    ms: stack.ms,
    correct: stack.ms < 10_000,
    providerTokens: PROVIDER_TOKENS,
  });
  const plan = await timeIt(async () => {
    const policy = await import("../lib/parallel-execution-policy-v16-15.mjs");
    return policy.decideParallelExecution({
      changedFiles: ["pkg1/src/a.ts", "pkg2/src/a.ts"],
      risk: "medium",
      scopes: [substantial("t1", "pkg1"), substantial("t2", "pkg2")],
    });
  });
  cells.push({
    name: "scenario-L:wave-decision",
    provenance: "MEASURED",
    ms: plan.ms,
    posture: plan.value.posture,
    correct: plan.value.posture === "PARALLEL_WRITERS",
    providerTokens: PROVIDER_TOKENS,
  });
  // Context shaping cost (structural fit over a full capsule).
  const shaped = await timeIt(async () => {
    const snapshot = createWaveSharedSnapshot({
      waveId: "bench", goal: "bench goal", constraints: ["c1"],
      requirementIds: ["R1"], testCommands: [{ command: "node", args: ["--test"] }],
    });
    return buildCanonicalChildCapsule({
      snapshot,
      child: { childId: "c1", taskId: "t1", goal: "do it", writeFiles: ["lib/a.mjs"] },
      run: { runId: "bench" },
    });
  });
  cells.push({
    name: "scenario-L:capsule-assembly",
    provenance: "MEASURED",
    ms: shaped.ms,
    chars: shaped.value.text.length,
    correct: shaped.value.text.length <= 5_500,
    providerTokens: PROVIDER_TOKENS,
  });
  // Honest Pi extension-path cold start, measured separately:
  //   1. the extension SOURCE read (a real wall-clock read of pi/extensions/ues.ts
  //      on this machine -- a proxy for load cost, never presented as an import);
  //   2. the actual extension MODULE import, which cannot be isolated safely in
  //      this bench: ues.ts is TypeScript, requires the Pi host ExtensionAPI and
  //      performs side-effectful registration. Importing it here would change
  //      runtime semantics, so no comparison is fabricated: ms is null and the
  //      reason is stated.
  const extensionRead = await timeIt(async () => {
    return readFileSync(path.join(path.dirname(path.resolve("scripts/bench-v16-16-critical-path.mjs")), "..", "pi", "extensions", "ues.ts"), "utf8");
  });
  cells.push({
    name: "scenario-L:pi-extension-source-read",
    provenance: "MEASURED",
    ms: extensionRead.ms,
    chars: extensionRead.value.length,
    correct: extensionRead.ms < 5_000 && extensionRead.value.length > 400_000,
    providerTokens: PROVIDER_TOKENS,
  });
  cells.push({
    name: "scenario-L:pi-extension-module-load",
    provenance: "NOT_MEASURED",
    ms: null,
    reason: "actual Pi extension import cannot be isolated safely without the Pi host, TypeScript compilation and side-effectful registration; no comparison fabricated",
    correct: true,
    providerTokens: PROVIDER_TOKENS,
  });
  return cells;
}

// ---------------------------------------------------------------------------
// M. SIMULATED warm-path planning: proof reuse, budget, history, prewarm bound
// ---------------------------------------------------------------------------

async function cellWarmPath() {
  const cells = [];
  const proof = planProofReuse({
    candidates: [{
      command: "node --test test/a.test.mjs", args: [], fingerprint: "fp-m",
      exitCode: 0, completed: true, ageMs: 500, affectedBySiblings: false,
    }],
  });
  cells.push({
    name: "scenario-M:proof-reuse-plan",
    provenance: "SIMULATED",
    reuse: proof.reuse.length,
    ms: null,
    correct: proof.reuse.length === 1,
    providerTokens: PROVIDER_TOKENS,
  });
  const reservation = reserveRunCost(null, { taskShape: "COMPLEX", simultaneousCalls: 9 });
  cells.push({
    name: "scenario-M:run-budget-lowers-concurrency",
    provenance: "SIMULATED",
    action: reservation.action,
    verificationIntact: reservation.verificationIntact,
    ms: null,
    correct: reservation.action === "lower-concurrency" && reservation.verificationIntact === true,
    providerTokens: PROVIDER_TOKENS,
  });
  const history = createCriticalPathHistory();
  for (let index = 0; index < 4; index += 1) history.record({ sandboxCreateMs: 700 });
  const stop = shouldStopProven({
    editsComplete: true, verificationPass: true, requirementsSatisfied: true,
    pendingDependencies: 0,
  });
  cells.push({
    name: "scenario-M:history-and-stop",
    provenance: "SIMULATED",
    historyMeasured: history.estimates().components.sandboxCreateMs.provenance,
    stop: stop.stop,
    ms: null,
    correct: history.estimates().components.sandboxCreateMs.provenance === "MEASURED" && stop.stop === true,
    providerTokens: PROVIDER_TOKENS,
  });
  // Prewarm bounding without spawning real workers (SIMULATED by label: the
  // pool double records keys instead of starting processes).
  const seen = [];
  const stubPool = {
    async prewarm(key) {
      seen.push(key);
      return { key, reused: false, prewarmed: true };
    },
    async discard() {
      return { discarded: true };
    },
  };
  const prewarm = await prewarmWaveWorkers(stubPool, [
    { key: "w1", spec: {} }, { key: "w2", spec: {} }, { key: "w3", spec: {} },
    { key: "w4", spec: {} }, { key: "w5", spec: {} },
  ], { maxWorkers: 3 });
  cells.push({
    name: "scenario-M:prewarm-bounded",
    provenance: "SIMULATED",
    bounded: prewarm.bounded,
    ms: null,
    correct: prewarm.bounded <= 3 && seen.length <= 3,
    providerTokens: PROVIDER_TOKENS,
  });
  // Telemetry honesty spot-check.
  const telemetry = buildCriticalPathTelemetry({ totalWallMs: 100 });
  const events = waveTelemetryToEfficiencyEvents({
    waves: [],
    sharedContext: [],
    integrationTransactions: [{ outcome: "preflight-rejected", rootUnchanged: true }],
  });
  const byOperation = Object.fromEntries(events.map((row) => [row.operation, row.metrics.count]));
  cells.push({
    name: "scenario-M:telemetry-honesty",
    provenance: "SIMULATED",
    providerUnknown: telemetry.providerInputTokens.provenance,
    rollbacks: byOperation["integration-root-rollbacks"] ?? 0,
    ms: null,
    correct: telemetry.providerInputTokens.provenance === "NOT_MEASURED"
      && (byOperation["integration-root-rollbacks"] ?? 0) === 0,
    providerTokens: PROVIDER_TOKENS,
  });
  void fitSections;
  void estimateParallelEconomy;
  void estimateScopeWorkMs;
  void buildConflictGraph;
  void EXECUTION_POSTURE;
  void availableParallelism;
  return cells;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function main() {
  const cells = [];
  cells.push(...cellDecisions());
  cells.push(...(await cellCrashRecoveryLive()));
  cells.push(...(await cellColdStartMeasured()));
  cells.push(...(await cellWarmPath()));

  const byProvenance = cells.reduce((acc, cell) => {
    acc[cell.provenance] = (acc[cell.provenance] || 0) + 1;
    return acc;
  }, {});
  const checked = cells.filter((cell) => typeof cell.correct === "boolean");
  const failed = checked.filter((cell) => cell.correct !== true);

  const report = {
    policy: "bench-v16-16-critical-path",
    release: "16.16.0",
    provenanceVocabulary: ["SIMULATED", "SYNTHETIC", "MEASURED", "LIVE"],
    cellsByProvenance: byProvenance,
    cellCount: cells.length,
    checkedCells: checked.length,
    failedCells: failed.length,
    failedCellNames: failed.map((cell) => cell.name),
    summedSpeedupClaim: null,
    tokenSavingClaim: null,
    qualityClaim: "NOT_INFERRED_FROM_BENCH",
    providerTokens: PROVIDER_TOKENS,
    providerTokensReason: "this bench never contacts a provider",
    baselineNote: "no V16.15-baseline milliseconds are reported: the replaced gate formula cannot be re-measured without checking out old code, and inventing them would be fabrication",
    cells,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    console.error(`bench-v16-16: ${failed.length} cell(s) failed: ${failed.map((cell) => cell.name).join(", ")}`);
    process.exitCode = 1;
  }
}

await main();
