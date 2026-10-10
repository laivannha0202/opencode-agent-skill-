// V16.17 POST-TAG PRODUCTION SMOKE — bounded structured-plan path.
//
// This test drives the REAL shipped extension module (`pi/extensions/ues.ts`)
// through the SAME controller entry the real Pi `ues_execute` tool calls:
// `executeStructuredPlan`. It does NOT call V16.17 helper modules directly.
//
// Scope of the smoke:
//   * one READ-ONLY structured task,
//   * one WRITER structured task,
//   * two INDEPENDENT writers in a temporary Git repository,
//   * the run-scoped budget ledger is ACTIVE for the whole run,
//   * no `undefined`/`ReferenceError` identifier reaches the production path,
//   * the LOCAL VERIFIER remains the sole PASS authority: the child stub only
//     ever produces an implementation handoff, and the run may only report
//     `passed: true` when the verifier role emitted `UES_VERDICT: PASS`.
//
// The only thing stubbed is the child transport (`PiRpcWorkerPool.run/prewarm/
// discard`), because spawning a real `pi` process is the `smoke:pi` domain.
// Everything else — wave compilation, admission, sandbox creation, integration
// transaction, verification plumbing, ledger settlement — is production code.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { PiRpcWorkerPool } from "../lib/pi-rpc-pool.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const TYPEBOX_STUB = [
  "const handler = { get: () => new Proxy(function () {}, handler), apply: () => new Proxy(function () {}, handler) };",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(label) {
  const base = path.join(os.tmpdir(), `ues-v1617-smoke-${label}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`);
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "core.autocrlf", "false"], repo);
  git(["config", "user.email", "smoke@ues.invalid"], repo);
  git(["config", "user.name", "UES Smoke"], repo);
  writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return { base, repo };
}

async function bootExtension() {
  const probeDir = path.join(ROOT, ".ues-cache", `v16-17-smoke-${process.pid}`);
  mkdirSync(probeDir, { recursive: true });
  const stub = path.join(probeDir, "typebox-stub.mjs");
  writeFileSync(stub, TYPEBOX_STUB, "utf8");
  const probe = path.join(ROOT, "pi", "extensions", `__v1617_smoke_${process.pid}_${Math.random().toString(16).slice(2, 8)}.mjs`);
  let source = stripTypeScriptTypes(readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8"), {
    mode: "strip",
    sourceUrl: "pi/extensions/ues.ts",
  });
  const stubUrl = pathToFileURL(stub).href;
  source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`);
  writeFileSync(probe, source, "utf8");
  try {
    return await import(pathToFileURL(probe).href);
  } finally {
    rmSync(probe, { force: true });
    // The typebox stub is only needed while the module graph is evaluated.
    try { rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
}

// Phase-aware child transport stub. It classifies each RPC turn by its prompt
// (the production code sends the verifier its own role-specific instruction).
// Only the VERIFIER role may emit `UES_VERDICT: PASS`; the implementation role
// never does, so a PASS can only come from the verifier.
function installChildStub(state) {
  const originalRun = PiRpcWorkerPool.prototype.run;
  const originalPrewarm = PiRpcWorkerPool.prototype.prewarm;
  const originalDiscard = PiRpcWorkerPool.prototype.discard;
  PiRpcWorkerPool.prototype.run = async function (key, spec, message, options) {
    const cwd = spec.cwd;
    const text = String(message || "");
    state.runs.push({ key, cwd, agent: spec.env?.UES_CHILD_AGENT || null, role: spec.env?.UES_CHILD_ROLE || null, options });

    // The production runtime labels every child authoritatively via
    // `UES_CHILD_AGENT`; classification never relies on fuzzy prompt matching.
    const isVerifier = String(spec.env?.UES_CHILD_AGENT || "") === "ues-verifier";
    if (isVerifier) {
      state.verifierRuns.push({ cwd });
      return {
        message: { role: "assistant", content: [{ type: "text", text: "verified\nUES_VERDICT: PASS" }], stopReason: "stop" },
        stderr: "",
        toolCalls: 0,
        toolNames: [],
        workerReused: false,
        verdict: "PASS",
        exitCode: 0,
      };
    }
    state.implementationRuns.push({ cwd });
    // A writer child creates its declared file inside its ISOLATED worktree.
    // The declared scope comes from the task JSON the production code embeds in
    // the prompt (`files.create` / `files.modify`), never from a test guess.
    // The controller creates the task sandbox before spawning the child and
    // encodes the task id in the worktree directory name (`...-<waveId>-<taskId>`),
    // so the declared scope is resolved from the production-provided worktree
    // identity, never from a fuzzy prompt match.
    const taskId = String(path.basename(cwd)).split("-").pop();
    const create = state.scopeByTask.get(taskId) || [];
    state.createdInSandbox.push({ cwd, taskId, create });
    for (const file of create) {
      const target = path.join(cwd, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `written by ${file}\n`, "utf8");
    }
    return {
      message: { role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" },
      stderr: "",
      toolCalls: 0,
      toolNames: [],
      workerReused: false,
      verdict: null,
      exitCode: 0,
    };
  };
  PiRpcWorkerPool.prototype.prewarm = async function (key) {
    state.prewarms.push(key);
    return { key, reused: false, prewarmed: true };
  };
  PiRpcWorkerPool.prototype.discard = async function () {
    return true;
  };
  return () => {
    PiRpcWorkerPool.prototype.run = originalRun;
    PiRpcWorkerPool.prototype.prewarm = originalPrewarm;
    PiRpcWorkerPool.prototype.discard = originalDiscard;
  };
}

test("V16.17 production smoke: read-only + writer wave through executeStructuredPlan", async (t) => {
  const { base, repo } = makeRepo("rw");
  const mod = await bootExtension();
  const state = {
    runs: [],
    implementationRuns: [],
    verifierRuns: [],
    prewarms: [],
    createdInSandbox: [],
    scopeByTask: new Map([["w1", ["b.txt"]]]),
  };
  const restore = installChildStub(state);
  process.env.UES_CHILD_RUNTIME = "rpc";
  try {
    const before = git(["status", "--porcelain"], repo);
    const result = await mod.executeStructuredPlan({
      plan: {
        schemaVersion: 1,
        goal: "production smoke: one read-only task and one writer task",
        mode: "execute",
        tasks: [
          {
            id: "r1",
            title: "inspect a.txt",
            summary: "read a.txt and report",
            risk: "low",
            acceptance: ["read"],
            verification: ["read"],
            dependsOn: [],
            files: { modify: ["a.txt"] },
            readOnly: true,
          },
          {
            id: "w1",
            title: "create b.txt",
            summary: "write b.txt",
            risk: "low",
            acceptance: ["wrote b.txt"],
            verification: ["wrote b.txt"],
            dependsOn: [],
            files: { create: ["b.txt"] },
          },
        ],
      },
      root: repo,
      maxAttempts: 1,
      traceID: `smoke-rw-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 600_000,
      rootPolicy: {},
    });

    // The run-scoped budget ledger MUST be active (never an undefined identifier).
    assert.ok(result.schedule, "production smoke: schedule report present (ledger active)");
    assert.equal(result.schedule?.runBudgetLedger?.policy, "run-budget-ledger-v16-17");
    assert.equal(typeof result.schedule.runBudgetLedger.runStartedAt, "number");
    assert.ok(result.schedule.runBudgetLedger.runStartedAt > 1e12, "runStartedAt is a real wall-clock time");
    assert.equal(result.schedule.runBudgetLedger.verificationIntact, true, "verification stayed intact");
    assert.equal(result.schedule.runBudgetLedger.totalTokens, null, "tokens are NOT_MEASURED, never fabricated");

    // The local verifier is the SOLE PASS authority: a PASS requires a verifier run.
    assert.equal(result.passed, true, `smoke must pass, got ${result.reason}: ${result.failure}`);
    assert.ok(state.verifierRuns.length > 0, "verifier role ran and is the PASS authority");
    assert.ok(state.implementationRuns.length > 0, "implementation children ran");

    // The writer's declared file reached the live root through integration.
    assert.equal(readFileSync(path.join(repo, "b.txt"), "utf8"), "written by b.txt\n");
    assert.notEqual(git(["status", "--porcelain"], repo), before, "live root changed by the writer");

    // Integration may only add the DECLARED source file. Parent-owned runtime
    // telemetry (`.ues-*`) legitimately lives at the live root and is created by
    // the parent itself, never carried back from a sandbox: excluding it, the
    // integration transaction applied exactly the declared source file.
    const status = git(["status", "--porcelain"], repo);
    const tracked = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim())
      .filter((file) => !/^\.ues-(cache|work|traces|learning|dashboard|sandboxes|memory|evals|services)\//.test(file));
    assert.deepEqual(tracked, ["b.txt"], "integration applied exactly the declared source file and nothing else");
  } finally {
    restore();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});

test("V16.17 production smoke: two independent writers stay isolated and both integrate", async (t) => {
  const { base, repo } = makeRepo("w2");
  const mod = await bootExtension();
  const state = {
    runs: [],
    implementationRuns: [],
    verifierRuns: [],
    prewarms: [],
    createdInSandbox: [],
    scopeByTask: new Map([["w1", ["x1.txt"]], ["w2", ["x2.txt"]]]),
  };
  const restore = installChildStub(state);
  process.env.UES_CHILD_RUNTIME = "rpc";
  process.env.UES_WRITER_PARALLEL = "2";
  try {
    const result = await mod.executeStructuredPlan({
      plan: {
        schemaVersion: 1,
        goal: "production smoke: two independent writers",
        mode: "execute",
        tasks: [
          {
            id: "w1",
            title: "create x1.txt",
            summary: "write x1.txt",
            risk: "low",
            acceptance: ["wrote x1.txt"],
            verification: ["wrote x1.txt"],
            dependsOn: [],
            files: { create: ["x1.txt"] },
          },
          {
            id: "w2",
            title: "create x2.txt",
            summary: "write x2.txt",
            risk: "low",
            acceptance: ["wrote x2.txt"],
            verification: ["wrote x2.txt"],
            dependsOn: [],
            files: { create: ["x2.txt"] },
          },
        ],
      },
      root: repo,
      maxAttempts: 1,
      traceID: `smoke-w2-${process.pid}`,
      runStartedAt: Date.now(),
      runWallClockMs: 600_000,
      rootPolicy: {},
    });

    assert.equal(result.schedule?.runBudgetLedger?.policy, "run-budget-ledger-v16-17");
    assert.equal(result.schedule.runBudgetLedger.verificationIntact, true);
    assert.equal(result.passed, true, `two-writer smoke must pass, got ${result.reason}: ${result.failure}`);
    assert.ok(state.verifierRuns.length > 0, "verifier role is the PASS authority");

    // Both writers integrated into the live root.
    assert.equal(readFileSync(path.join(repo, "x1.txt"), "utf8"), "written by x1.txt\n");
    assert.equal(readFileSync(path.join(repo, "x2.txt"), "utf8"), "written by x2.txt\n");

    // Each writer ran in its OWN isolated worktree created by the production
    // `createTaskSandbox` (never the live root), and each only ever created its
    // OWN declared file there.
    const implCwds = state.implementationRuns.map((row) => row.cwd);
    assert.equal(new Set(implCwds).size, 2, "two independent writers used two distinct worktrees");
    for (const cwd of implCwds) {
      assert.match(path.basename(path.dirname(path.resolve(cwd))), /^\.repo\.ues-sandboxes$/, "sandbox lives in the production sandbox base");
    }
    const created = new Set(state.createdInSandbox.flatMap((row) => row.create));
    assert.deepEqual([...created].sort(), ["x1.txt", "x2.txt"], "both declared files were created in sandboxes");
    for (const cwd of implCwds) {
      assert.ok(path.resolve(cwd) !== path.resolve(repo), "no writer implementation ran directly in the live root");
    }

    // PEAK writer concurrency is bounded by the compiled decision, never summed.
    const snapshot = result.schedule.runBudgetLedger;
    assert.ok(snapshot.peak?.activeWriterConcurrency >= 1, "peak writer concurrency recorded");
    assert.ok(snapshot.peak.activeWriterConcurrency <= 3, "peak writer concurrency stays within the hard max");

    // Integration may only add the two DECLARED source files (parent-owned
    // runtime telemetry at the live root is excluded, as above).
    const status = git(["status", "--porcelain"], repo);
    const tracked = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim())
      .filter((file) => !/^\.ues-(cache|work|traces|learning|dashboard|sandboxes|memory|evals|services)\//.test(file));
    assert.deepEqual(tracked.sort(), ["x1.txt", "x2.txt"], "integration applied exactly the two declared source files and nothing else");
  } finally {
    restore();
    delete process.env.UES_WRITER_PARALLEL;
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});
