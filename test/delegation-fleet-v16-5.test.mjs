// V16.5 bounded parallel delegation: PRODUCTION-PATH regression.
//
// The gap this file closes: V16.5 shipped wave planning (lib/delegation-safety)
// and a child lifecycle (lib/subagent-fabric), but the controller executed its
// children one at a time, so no real multi-child run ever exercised the wave
// path. lib/delegation-fleet.mjs is now wired into
// `executeStructuredPlan` in pi/extensions/ues.ts and this file drives it.
//
// What is proven here, through the real production module:
//
//   A two independent read-only children overlap (deterministic latch, not timing)
//   B max concurrency 2 is enforced
//   C the third child waits
//   D overlapping writer tasks are serialized
//   E external-side-effect tasks are serialized / blocked from parallel replay
//   F a child failure never becomes a global PASS
//   G output order is deterministic regardless of completion order
//   H cancellation cleans up every active child
//   I no orphan process survives cancellation (real OS processes)
//   J cycle / depth guards still fail closed
//   K unsafe scopes keep the existing serial behavior
//
// Plus production wiring: the shipped pi/extensions/ues.ts really imports the
// fleet, really calls the bounded executor, and really reports the telemetry.
//
// No live model, no network, no DeepSeek.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DELEGATION_FLEET_SCHEMA_VERSION,
  FLEET_LIMITS,
  FLEET_OUTCOME,
  createDelegationFleetTelemetry,
  delegationFleetTelemetry,
  resolveFleetConcurrency,
  runDelegationWave,
} from "../lib/delegation-fleet.mjs";
import {
  DELEGATION_STOP_REASONS,
  FABRIC_LIMITS,
  createDelegationSession,
  delegationSummary,
} from "../lib/subagent-fabric.mjs";
import { PARALLEL_BLOCK_REASON } from "../lib/delegation-safety.mjs";
import { runSupervisedProcess } from "../lib/process-supervisor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Race a delay against an abort, then CLEAR the delay timer. A plain Promise.race
 * leaves the losing timer pending, which would keep the test process alive for the
 * full delay after the assertion already finished.
 */
function raceAbort(ms, signal) {
  let timer = null;
  const delay = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  const aborted = signal
    ? new Promise((resolve) => {
        if (signal.aborted) resolve("aborted");
        else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      })
    : new Promise(() => {});
  return Promise.race([delay, aborted]).finally(() => clearTimeout(timer));
}

function readOnlyScope(id, file) {
  return { id, key: id, role: "explore", readOnly: true, files: [file], task: `map ${file}` };
}

function newSession(options = {}) {
  return createDelegationSession({ parentId: "p", parentAgent: "controller", ...options });
}

/**
 * Deterministic barrier. Two children that both wait here can only both finish
 * if they ran at the same time, so the assertion does not depend on a sleep
 * budget. A serial executor deadlocks here and the latch reports it instead.
 */
function rendezvous(parties, timeoutMs = 4_000) {
  let arrived = 0;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const state = { opened: false, timedOut: false, arrived: 0 };
  return {
    state,
    async arrive() {
      arrived += 1;
      state.arrived = arrived;
      if (arrived >= parties) {
        state.opened = true;
        openGate();
        return;
      }
      const timeout = sleep(timeoutMs).then(() => "timeout");
      const winner = await Promise.race([gate.then(() => "gate"), timeout]);
      if (winner === "timeout") state.timedOut = true;
    },
  };
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// A. two independent read-only children overlap
// ---------------------------------------------------------------------------
test("V16.5 fleet A: two independent read-only children overlap in wall-clock execution", async () => {
  const latch = rendezvous(2);
  const session = newSession();
  const started = Date.now();

  const result = await runDelegationWave({
    session,
    scopes: [readOnlyScope("task-a", "src/a.ts"), readOnlyScope("task-b", "src/b.ts")],
    execute: async (scope) => {
      // A sequential executor can never open this barrier: the first child would
      // wait for a second child that is not allowed to start.
      await latch.arrive();
      await sleep(60);
      return { exitCode: 0, output: scope.id };
    },
  });

  const wallMs = Date.now() - started;
  assert.equal(latch.state.opened, true, "children did not overlap: the barrier never opened");
  assert.equal(latch.state.timedOut, false);
  assert.equal(result.telemetry.maxObservedChildConcurrency, 2);
  assert.equal(result.safeWaveCount, 1);
  assert.equal(result.telemetry.parallelDelegations, 2);
  assert.equal(result.telemetry.serializedDelegations, 0);

  // Measured, not a speedup claim: two 60ms children overlapped, so the wave is
  // meaningfully shorter than the sequential equivalent. The bound is generous so
  // a slow CI box cannot make this flaky.
  const { sequentialEquivalentMs, parallelWallMs, overlapSavingsMs, provenance } = result.telemetry;
  assert.equal(provenance, "MEASURED");
  assert.ok(parallelWallMs < sequentialEquivalentMs, `${parallelWallMs} !< ${sequentialEquivalentMs}`);
  assert.ok(overlapSavingsMs > 0);
  assert.ok(wallMs < sequentialEquivalentMs + 1_500, `parallel wall ${wallMs} is not overlapping`);
});

// ---------------------------------------------------------------------------
// B + C. bounded concurrency, and the third child waits
// ---------------------------------------------------------------------------
test("V16.5 fleet B/C: concurrency never exceeds the configured budget and extra children wait", async () => {
  const session = newSession();
  let active = 0;
  let peak = 0;
  const windows = [];

  const result = await runDelegationWave({
    session,
    maxParallel: 2,
    scopes: ["t1", "t2", "t3", "t4", "t5"].map((id, index) => readOnlyScope(id, `src/dir${index}/${id}.ts`)),
    execute: async (scope) => {
      const openedAt = Date.now();
      active += 1;
      peak = Math.max(peak, active);
      await sleep(70);
      active -= 1;
      windows.push({ id: scope.id, openedAt, closedAt: Date.now() });
      return { exitCode: 0, output: scope.id };
    },
  });

  assert.equal(peak, 2, "concurrency budget was exceeded");
  assert.equal(result.telemetry.maxObservedChildConcurrency, 2);
  assert.ok(result.telemetry.childQueueMs > 0, "queued children must record real queue time");

  // At most two windows may be open at any instant: the i-th window cannot open
  // before the (i-2)-th has closed. This also proves the third child WAITS.
  const ordered = [...windows].sort((a, b) => a.openedAt - b.openedAt);
  assert.ok(ordered.length === 5);
  for (let i = 2; i < ordered.length; i += 1) {
    assert.ok(
      ordered[i].openedAt >= ordered[i - 2].closedAt,
      `${ordered[i].id} overlapped ${ordered[i - 1].id} and ${ordered[i - 2].id}`,
    );
  }
  assert.ok(ordered[2].openedAt >= ordered[0].closedAt, "the third child did not wait for a free slot");
  assert.equal(result.completed, 5);
  assert.equal(result.failed, 0);
  assert.equal(delegationSummary(session).orphansRemaining, 0);
});

test("V16.5 fleet B: a request above the hard max is capped, never honoured", () => {
  assert.equal(resolveFleetConcurrency(undefined), FLEET_LIMITS.defaultConcurrency);
  assert.equal(resolveFleetConcurrency(undefined), FABRIC_LIMITS.defaultActiveChildren);
  assert.equal(resolveFleetConcurrency(99), FLEET_LIMITS.hardMaxConcurrency);
  assert.equal(resolveFleetConcurrency(99), FABRIC_LIMITS.maxActiveChildren);
  assert.equal(FLEET_LIMITS.defaultConcurrency, 2);
  assert.equal(FLEET_LIMITS.hardMaxConcurrency, 3);
  assert.equal(resolveFleetConcurrency(0), FLEET_LIMITS.defaultConcurrency);
  assert.equal(resolveFleetConcurrency("not-a-number"), FLEET_LIMITS.defaultConcurrency);
});

// ---------------------------------------------------------------------------
// D + E + K. unsafe scopes stay serial
// ---------------------------------------------------------------------------
test("V16.5 fleet D: overlapping writers are serialized, never co-scheduled", async () => {
  const session = newSession();
  let active = 0;
  let peak = 0;
  const windows = [];

  const result = await runDelegationWave({
    session,
    scopes: [
      { id: "w1", key: "w1", role: "implement", readOnly: false, files: ["src/c.ts"], task: "edit c" },
      { id: "w2", key: "w2", role: "implement", readOnly: false, files: ["src/c.ts"], task: "edit c again" },
    ],
    execute: async (scope) => {
      const openedAt = Date.now();
      active += 1;
      peak = Math.max(peak, active);
      await sleep(50);
      active -= 1;
      windows.push({ id: scope.id, openedAt, closedAt: Date.now() });
      return { exitCode: 0, output: scope.id };
    },
  });

  assert.equal(peak, 1, "two overlapping writers ran at the same time");
  assert.equal(result.telemetry.maxObservedChildConcurrency, 1);
  assert.equal(result.telemetry.parallelDelegations, 0);
  assert.equal(result.telemetry.serializedDelegations, 2);
  assert.equal(result.safeWaveCount, 0);
  assert.ok(result.waves.length === 2);
  assert.ok(result.blockReasons.includes(PARALLEL_BLOCK_REASON.WRITER_OVERLAP));
  assert.equal(result.hasUnsafeBlock, true);

  const ordered = [...windows].sort((a, b) => a.openedAt - b.openedAt);
  assert.ok(ordered[1].openedAt >= ordered[0].closedAt, "writer windows overlapped");
});

test("V16.5 fleet E: external side effects are serialized and never replayed in parallel", async () => {
  const session = newSession();
  let active = 0;
  let peak = 0;

  const result = await runDelegationWave({
    session,
    scopes: [
      { id: "pub", key: "pub", role: "implement", readOnly: false, files: ["package.json"], task: "npm publish the package" },
      { id: "dep", key: "dep", role: "implement", readOnly: false, files: ["docker/app.yml"], task: "deploy to production" },
    ],
    execute: async (scope) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(40);
      active -= 1;
      return { exitCode: 0, output: scope.id };
    },
  });

  assert.equal(peak, 1);
  assert.equal(result.telemetry.parallelDelegations, 0);
  assert.ok(result.blockReasons.includes(PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT));
  assert.equal(result.telemetry.maxObservedChildConcurrency, 1);
  assert.equal(result.completed, 2, "serialization must still execute both children");
});

test("V16.5 fleet K: a single unsafe scope keeps the existing serial behaviour", async () => {
  const result = await runDelegationWave({
    session: newSession(),
    scopes: [
      { id: "svc", key: "svc", role: "implement", readOnly: false, files: ["src/app.ts"], task: "start the dev server" },
    ],
    execute: async (scope) => {
      await sleep(20);
      return { exitCode: 0, output: scope.id };
    },
  });
  assert.equal(result.telemetry.maxObservedChildConcurrency, 1);
  assert.equal(result.telemetry.parallelDelegations, 0);
  assert.equal(result.telemetry.serializedDelegations, 1);
  assert.ok(result.blockReasons.includes(PARALLEL_BLOCK_REASON.MUTABLE_SERVICE));
  assert.equal(result.completed, 1);
});

test("V16.5 fleet D/K: destructive shell is never co-scheduled with anything", async () => {
  const result = await runDelegationWave({
    session: newSession(),
    scopes: [
      { id: "rm", key: "rm", role: "implement", readOnly: false, files: ["build/out.js"], task: "rm -rf build" },
      { id: "ro", key: "ro", role: "explore", readOnly: true, files: ["src/x.ts"], task: "map x" },
    ],
    execute: async (scope) => ({ exitCode: 0, output: scope.id }),
  });
  assert.ok(result.blockReasons.includes(PARALLEL_BLOCK_REASON.DESTRUCTIVE_SHELL));
  assert.equal(result.telemetry.parallelDelegations, 0);
  assert.equal(result.telemetry.maxObservedChildConcurrency, 1);
});

// ---------------------------------------------------------------------------
// F + G. failure aggregation and deterministic ordering
// ---------------------------------------------------------------------------
test("V16.5 fleet F: one child failing never becomes a global PASS and never cancels its sibling", async () => {
  const session = newSession();
  let siblingCompleted = false;
  let siblingCancelled = false;

  const result = await runDelegationWave({
    session,
    scopes: [readOnlyScope("good", "src/good.ts"), readOnlyScope("bad", "src/bad.ts")],
    execute: async (scope, ctx) => {
      if (scope.id === "bad") throw new Error("child exploded");
      const outcome = await raceAbort(120, ctx.signal);
      if (outcome === "aborted") siblingCancelled = true;
      else siblingCompleted = true;
      return { exitCode: 0, output: "good output" };
    },
  });

  assert.equal(siblingCancelled, false, "an unrelated read-only sibling was cancelled");
  assert.equal(siblingCompleted, true);
  assert.equal(result.passed, false, "a failed child must never yield a global PASS");
  assert.equal(result.canProduceVerdict, false);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);

  const bad = result.ordered.find((row) => row.id === "bad");
  assert.equal(bad.ok, false);
  assert.equal(bad.status, FLEET_OUTCOME.FAILED);
  assert.equal(bad.stopReason, DELEGATION_STOP_REASONS.CHILD_FAILED);
  assert.equal(bad.result, null, "a failed child must not leak a partial result as success");
  assert.equal(bad.canProduceVerdict, false);
  assert.match(String(bad.error), /child exploded/);

  const good = result.ordered.find((row) => row.id === "good");
  assert.equal(good.ok, true);
  assert.equal(good.result.output, "good output");
  assert.equal(delegationSummary(session).completed, 1);
  assert.equal(delegationSummary(session).failed, 1);
});

test("V16.5 fleet G: output order is deterministic even when completion order differs", async () => {
  const scopes = ["t-a", "t-b", "t-c", "t-d"].map((id) => readOnlyScope(id, `src/${id}.ts`));
  // Deliberately reversed durations so completion order differs from key order.
  const delays = { "t-a": 120, "t-b": 10, "t-c": 80, "t-d": 30 };
  const completionOrder = [];

  const forward = await runDelegationWave({
    session: newSession({ maxActiveChildren: 3 }),
    maxParallel: 3,
    scopes,
    execute: async (scope) => {
      await sleep(delays[scope.id]);
      completionOrder.push(scope.id);
      return { exitCode: 0, output: scope.id };
    },
  });

  const shuffled = await runDelegationWave({
    session: newSession({ maxActiveChildren: 3 }),
    maxParallel: 3,
    scopes: [...scopes].reverse(),
    execute: async (scope) => {
      await sleep(delays[scope.id]);
      return { exitCode: 0, output: scope.id };
    },
  });

  const forwardIds = forward.ordered.map((row) => row.id);
  const shuffledIds = shuffled.ordered.map((row) => row.id);
  assert.deepEqual(forwardIds, [...forwardIds].sort());
  assert.deepEqual(forwardIds, shuffledIds, "input order must not change output order");
  assert.deepEqual(
    forward.ordered.map((row) => row.result.output),
    forwardIds,
  );
  // The completion order genuinely differed from the emitted order.
  assert.notDeepEqual(completionOrder, forwardIds);
  assert.deepEqual([...completionOrder].sort(), forwardIds);
});

test("V16.5 fleet G: rejections and failures still occupy their deterministic slot", async () => {
  const result = await runDelegationWave({
    session: newSession({ maxActiveChildren: 3 }),
    maxParallel: 3,
    scopes: ["t-a", "t-b", "t-c"].map((id) => readOnlyScope(id, `src/${id}.ts`)),
    execute: async (scope) => {
      if (scope.id === "t-b") throw new Error("boom");
      if (scope.id === "t-c") return { exitCode: 2, output: "verifier said FAIL" };
      return { exitCode: 0, output: scope.id };
    },
  });
  assert.deepEqual(result.ordered.map((row) => row.id), ["t-a", "t-b", "t-c"]);
  // t-b threw, t-c reported exitCode 2 (verifier FAIL). Both are failures, and
  // both still occupy their deterministic slot instead of shifting the array.
  assert.deepEqual(result.ordered.map((row) => row.ok), [true, false, false]);
  assert.deepEqual(result.ordered.map((row) => row.status), [
    FLEET_OUTCOME.COMPLETED,
    FLEET_OUTCOME.FAILED,
    FLEET_OUTCOME.FAILED,
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 2);
  // A child process that exited non-zero must not surface a "result" payload as
  // if it were a verified finding.
  assert.equal(result.ordered[2].result, null);
});

// ---------------------------------------------------------------------------
// H + I. cancellation, cleanup, no orphan
// ---------------------------------------------------------------------------
test("V16.5 fleet H: cancelling the parent cancels every active child and leaves no orphan", async () => {
  const session = newSession();
  const controller = new AbortController();
  const started = [];

  const running = runDelegationWave({
    session,
    scopes: ["t-a", "t-b"].map((id) => readOnlyScope(id, `src/${id}.ts`)),
    signal: controller.signal,
    execute: async (scope, ctx) => {
      started.push(scope.id);
      await raceAbort(5_000, ctx.signal);
      return { exitCode: 130, stopReason: "aborted", output: `${scope.id} aborted` };
    },
  });

  // Wait for the wave to be genuinely in flight before cancelling.
  while (started.length < 2) await sleep(5);
  controller.abort();
  const result = await running;

  assert.deepEqual(started.sort(), ["t-a", "t-b"]);
  assert.equal(result.cancelled, true);
  assert.equal(result.noOrphans, true);
  for (const row of result.ordered) {
    assert.equal(row.ok, false, `${row.id} reported success after cancellation`);
    assert.equal(row.result, null);
  }
  const summary = delegationSummary(session);
  assert.equal(summary.orphansRemaining, 0);
  assert.equal(summary.cancelled, 2);
  assert.equal(result.passed, false);
});

test("V16.5 fleet I: cancellation leaves no orphan OS process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-fleet-orphan-"));
  const pidFile = path.join(dir, "pid.txt");
  const controller = new AbortController();
  const session = newSession();
  const pids = [];

  try {
    const running = runDelegationWave({
      session,
      signal: controller.signal,
      scopes: [readOnlyScope("proc-a", "src/a.ts"), readOnlyScope("proc-b", "src/b.ts")],
      execute: async (scope, ctx) => {
        // A real, long-lived child process supervised by the EXISTING process
        // supervisor. The fleet only supplies ctx.signal.
        const result = await runSupervisedProcess(
          process.execPath,
          ["-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
          { signal: ctx.signal, hardTimeoutMs: 30_000, idleTimeoutMs: 30_000, killGraceMs: 500 },
        );
        pids.push({ id: scope.id, pid: result.pid, exitCode: result.exitCode, stopReason: result.stopReason });
        return { exitCode: result.exitCode, stopReason: result.stopReason, output: result.stdout };
      },
    });

    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await sleep(25);
    await sleep(250);
    assert.ok(existsSync(pidFile), "no real child process was started");

    const spawned = pids.length > 0 ? pids : [];
    controller.abort();
    const result = await running;
    assert.equal(result.noOrphans, true);
    assert.equal(delegationSummary(session).orphansRemaining, 0);

    const recorded = readFileSync(pidFile, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    assert.ok(recorded.length >= 1);
    // Windows may need a short bounded settle window under a saturated suite.
    // Poll instead of assuming every taskkill tree is observable as dead in 500ms.
    const settleDeadline = Date.now() + 5_000;
    while (recorded.some((pid) => processAlive(pid)) && Date.now() < settleDeadline) {
      await sleep(50);
    }
    for (const pid of recorded) {
      assert.equal(processAlive(pid), false, `orphan process ${pid} survived cancellation`);
    }
    for (const row of result.ordered) assert.equal(row.ok, false);
    void spawned;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.5 fleet: a watchdog-reaped child is terminated and reported, never silently passed", async () => {
  const session = newSession();
  const started = Date.now();
  const result = await runDelegationWave({
    session,
    watchdogIntervalMs: 25,
    scopes: [{ ...readOnlyScope("slow", "src/slow.ts"), timeoutMs: 5_000 }],
    execute: async (scope, ctx) => {
      const winner = await raceAbort(60_000, ctx.signal);
      return { exitCode: 124, stopReason: winner === "aborted" ? "aborted" : "idle-timeout", output: "" };
    },
  });
  const elapsed = Date.now() - started;
  // The fabric timeout floor is 5s, so the reaper must fire near that bound and
  // not let the child run to its own 60s lifetime.
  assert.ok(elapsed >= 5_000, `the child was reaped too early (${elapsed}ms)`);
  assert.ok(elapsed < 20_000, `the watchdog did not terminate the reaped child (${elapsed}ms)`);
  const row = result.ordered[0];
  assert.equal(row.ok, false);
  assert.equal(row.status, FLEET_OUTCOME.TIMED_OUT);
  assert.equal(row.stopReason, DELEGATION_STOP_REASONS.TIMEOUT);
  assert.equal(result.passed, false);
  assert.equal(result.canProduceVerdict, false);
  assert.equal(result.cancelledChildren, 1);
  // The fabric keeps the real stop reason instead of flattening it to a failure.
  const summary = delegationSummary(session);
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.orphansRemaining, 0);
});

test("V16.5 fleet: a child whose runner ignores cancellation still cannot be reported as PASS", async () => {
  const session = newSession();
  const result = await runDelegationWave({
    session,
    scopes: [readOnlyScope("liar", "src/liar.ts")],
    execute: async () => ({ exitCode: 1, output: "verifier said FAIL" }),
  });
  const row = result.ordered[0];
  assert.equal(row.ok, false, "a non-zero exit code is a failure, not a pass");
  assert.equal(row.status, FLEET_OUTCOME.FAILED);
  assert.equal(result.passed, false);
  assert.equal(result.completed, 0);
  assert.equal(delegationSummary(session).failed, 1);
});

// ---------------------------------------------------------------------------
// J. cycle / depth guards
// ---------------------------------------------------------------------------
test("V16.5 fleet J: depth and cycle guards still fail closed under the fleet", async () => {
  const tooDeep = newSession({ depth: FABRIC_LIMITS.hardMaxDepth });
  const deep = await runDelegationWave({
    session: tooDeep,
    scopes: [readOnlyScope("deep", "src/deep.ts")],
    execute: async () => ({ exitCode: 0, output: "should never run" }),
  });
  assert.equal(deep.ordered[0].status, FLEET_OUTCOME.REJECTED);
  assert.equal(deep.ordered[0].stopReason, DELEGATION_STOP_REASONS.DEPTH_EXCEEDED);
  assert.equal(deep.ordered[0].ok, false);
  assert.equal(deep.passed, false);

  // Cycle guard: the parent agent may not reappear in its own child stack.
  const parentStack = newSession({ parentAgent: "ues-executor" });
  const cyclic = await runDelegationWave({
    session: parentStack,
    scopes: [{ id: "recur", key: "recur", role: "implement", agent: "ues-executor", readOnly: false, files: ["src/r.ts"], task: "recurse" }],
    execute: async () => ({ exitCode: 0, output: "should never run" }),
  });
  assert.equal(cyclic.ordered[0].status, FLEET_OUTCOME.REJECTED);
  assert.equal(cyclic.ordered[0].stopReason, DELEGATION_STOP_REASONS.CYCLE_DETECTED);
  assert.equal(delegationSummary(parentStack).orphansRemaining, 0);
});

// ---------------------------------------------------------------------------
// telemetry contract
// ---------------------------------------------------------------------------
test("V16.5 fleet telemetry reports every required measurement and claims no speedup", async () => {
  const telemetry = createDelegationFleetTelemetry();
  const result = await runDelegationWave({
    session: newSession(),
    telemetry,
    scopes: [readOnlyScope("m1", "src/m1.ts"), readOnlyScope("m2", "src/m2.ts"), readOnlyScope("m3", "src/m3.ts")],
    execute: async (scope) => {
      await sleep(50);
      return { exitCode: 0, output: scope.id };
    },
  });

  const snapshot = delegationFleetTelemetry(telemetry);
  for (const key of [
    "safeWaveCount",
    "parallelDelegations",
    "serializedDelegations",
    "maxObservedChildConcurrency",
    "childQueueMs",
    "childExecutionMs",
    "parallelWallMs",
    "sequentialEquivalentMs",
    "overlapSavingsMs",
  ]) {
    assert.ok(key in snapshot, `${key} is missing`);
    assert.equal(typeof snapshot[key], "number", `${key} must be a number`);
  }
  assert.equal(snapshot.schemaVersion, DELEGATION_FLEET_SCHEMA_VERSION);
  assert.equal(snapshot.safeWaveCount, result.safeWaveCount);
  assert.equal(snapshot.maxObservedChildConcurrency, 2);
  assert.equal(snapshot.provenance, "MEASURED");
  assert.equal(snapshot.speedupClaim, null, "no speedup may be claimed from an unmeasured run");
  assert.match(snapshot.note, /not a speedup claim/i);
  assert.deepEqual(snapshot.limits, { defaultConcurrency: 2, hardMaxConcurrency: 3 });
  // Snapshot immutability: reading twice cannot mutate the accumulator.
  const before = delegationFleetTelemetry(telemetry).overlapSavingsMs;
  delegationFleetTelemetry(telemetry);
  assert.equal(delegationFleetTelemetry(telemetry).overlapSavingsMs, before);
});

// ---------------------------------------------------------------------------
// production wiring: the shipped extension really uses the fleet
// ---------------------------------------------------------------------------
function resolveRelative(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, "index.mjs")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a candidate */
    }
  }
  return null;
}

const STATIC_IMPORT = /(?:^|[\s;])import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|(?:^|[\s;])export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g;

function staticEagerClosure(rootFile) {
  const seen = new Set();
  const walk = (file, stack) => {
    const absolute = path.resolve(file);
    if (stack.has(absolute) || seen.has(absolute)) return;
    stack.add(absolute);
    seen.add(absolute);
    let source = "";
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    const pattern = new RegExp(STATIC_IMPORT.source, STATIC_IMPORT.flags);
    let match;
    while ((match = pattern.exec(source))) {
      const resolved = resolveRelative(match[1] || match[2], absolute);
      if (resolved) walk(resolved, stack);
    }
  };
  walk(path.resolve(rootFile), new Set());
  return [...seen].map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
}

test("V16.5 fleet production wiring: the controller runs the bounded fleet, not a serial loop", () => {
  const source = readFileSync(EXTENSION, "utf8");
  assert.ok(source.includes('from "../../lib/delegation-fleet.mjs"'), "the fleet is not imported by the runtime");
  for (const symbol of ["createDelegationFleetTelemetry(", "resolveFleetConcurrency(", "runDelegationWave(", "delegationFleetTelemetry("]) {
    assert.ok(source.includes(symbol), `${symbol} is never called by the controller`);
  }
  // The fleet replaces the raw mapLimit in the structured-plan wave loop.
  assert.ok(source.includes("const waveExecution = await runDelegationWave({"));
  assert.ok(source.includes("const waveResults = waveExecution.ordered.map("), "wave results are not deterministically ordered");
  // Concurrency is still bounded by the existing budget AND the V16.5 fleet cap.
  assert.ok(source.includes("resolveFleetConcurrency(process.env.UES_MAX_ACTIVE_CHILDREN)"));
  // Telemetry is reported on every scheduler return path.
  const scheduleReports = source.split("schedule: scheduleReport()").length - 1;
  assert.ok(scheduleReports >= 7, `only ${scheduleReports} scheduler return paths report delegation telemetry`);
  assert.ok(source.includes("parallelDelegation: delegationFleetTelemetry(delegationTelemetry)"));
});

test("V16.5 fleet production wiring: delegation-fleet is in the boot graph of the shipped extension", () => {
  const closure = staticEagerClosure(EXTENSION);
  for (const module of [
    "lib/delegation-fleet.mjs",
    "lib/delegation-safety.mjs",
    "lib/subagent-fabric.mjs",
    "lib/task-graph.mjs",
    "lib/process-supervisor.mjs",
  ]) {
    assert.ok(closure.includes(module), `${module} is not reachable from pi/extensions/ues.ts`);
  }
  // The fleet must not have become a second scheduler or a process spawner.
  const fleet = readFileSync(path.join(ROOT, "lib", "delegation-fleet.mjs"), "utf8");
  assert.ok(!/from "node:child_process"/.test(fleet), "the fleet must not spawn processes itself");
  assert.ok(!/spawn\s*\(/.test(fleet), "the fleet must not spawn processes itself");
  assert.ok(fleet.includes('from "./delegation-safety.mjs"'), "the fleet must reuse delegation-safety wave planning");
  assert.ok(fleet.includes('from "./subagent-fabric.mjs"'), "the fleet must reuse the subagent fabric lifecycle");
});

test("V16.5 fleet production wiring: the shipped extension still boots", async () => {
  const probeDir = path.join(ROOT, ".ues-cache", "v16-5-fleet-probe");
  const typeboxStub = [
    "const handler = {",
    "  get: () => new Proxy(function () {}, handler),",
    "  apply: () => new Proxy(function () {}, handler),",
    "};",
    "export const Type = new Proxy(function () {}, handler);",
    "export default { Type };",
  ].join("\n");
  const probe = path.join(path.dirname(EXTENSION), `__v165_fleet_probe_${process.pid}.mjs`);
  const stub = path.join(probeDir, "typebox-stub.mjs");
  try {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(stub, typeboxStub, "utf8");
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    });
    const stubUrl = pathToFileURL(stub).href;
    source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`);
    writeFileSync(probe, source, "utf8");
    try {
      const module = await import(pathToFileURL(probe).href);
      assert.equal(typeof module.default, "function", "the extension must still expose activate()");
    } finally {
      rmSync(probe, { force: true });
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});
