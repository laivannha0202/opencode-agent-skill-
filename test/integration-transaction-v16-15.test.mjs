// V16.15 Transactional Wave Integration.
//
// These tests use REAL Git repositories and REAL worktrees created through the
// existing sandbox owner (`lib/worktree-sandbox.mjs`). Nothing is simulated: the
// transaction is exercised against actual `git apply`, actual worktree metadata
// and actual root mutation, because the invariant being proven ("preflight ALL
// before mutating ANY", "rollback leaves the root byte-identical") is only
// meaningful against real Git state.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  COMPLETION_STATE,
  FAILURE_CLASS,
  INTEGRATION_OUTCOME,
  classifyChildFailure,
  createProgressWatchdog,
  decideRetry,
  deterministicIntegrationOrder,
  evaluateCompletion,
  planFailureCancellation,
  runIntegrationTransaction,
} from "../lib/integration-transaction-v16-15.mjs"
import {
  createTaskSandbox,
  preflightTaskSandbox,
  rootWorkspaceIdentity,
  taskSandboxOwnerRoot,
} from "../lib/worktree-sandbox.mjs"

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeRepo() {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-v1615-"))
  const root = path.join(base, "repo")
  mkdirSync(root, { recursive: true })
  git(root, ["init", "-q"])
  // The HOST machine's system-level `core.autocrlf=true` would rewrite line
  // endings on every checkout, so a byte-identity assertion would be measuring
  // this machine's Git configuration instead of the product's rollback logic.
  // Pin the temp repository to LF so the tests are host-independent.
  git(root, ["config", "core.autocrlf", "false"])
  git(root, ["config", "core.eol", "lf"])
  git(root, ["config", "user.email", "test@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  writeFileSync(path.join(root, "README.md"), "# repo\n", "utf8")
  mkdirSync(path.join(root, "lib"), { recursive: true })
  writeFileSync(path.join(root, "lib", "alpha.mjs"), "export const alpha = 1\n", "utf8")
  writeFileSync(path.join(root, "lib", "beta.mjs"), "export const beta = 1\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "init"])
  return { base, root }
}

function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

function readNormalized(file) {
  // Git may check files out with platform line endings; the assertion is about
  // CONTENT, so normalize CRLF before comparing.
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n")
}

// ---------------------------------------------------------------------------
// deterministic order
// ---------------------------------------------------------------------------

test("V16.15 integration order: order is a function of declared structure only", () => {
  const patches = [
    { taskId: "t3", wave: 1, dependsOn: ["t2"] },
    { taskId: "t1", wave: 0, dependsOn: [] },
    { taskId: "t2", wave: 1, dependsOn: ["t1"] },
  ]
  const ordering = deterministicIntegrationOrder(patches)
  assert.deepEqual(ordering.order, ["t1", "t2", "t3"])
  assert.equal(ordering.completionOrderIgnored, true)
  assert.equal(ordering.deterministic, true)
})

test("V16.15 integration order: completion order can never leak into the result", () => {
  const declared = [
    { taskId: "b", wave: 1, dependsOn: [] },
    { taskId: "a", wave: 1, dependsOn: [] },
    { taskId: "c", wave: 1, dependsOn: [] },
  ]
  const first = deterministicIntegrationOrder(declared)
  // The SAME declarations, presented in a different (completion) order.
  const second = deterministicIntegrationOrder([declared[2], declared[0], declared[1]])
  assert.deepEqual(first.order, second.order)
  assert.deepEqual(first.order, ["a", "b", "c"])
})

test("V16.15 integration order: dependency depth outranks wave number", () => {
  const ordering = deterministicIntegrationOrder([
    { taskId: "child", wave: 0, dependsOn: ["parent"] },
    { taskId: "parent", wave: 5, dependsOn: [] },
  ])
  assert.deepEqual(ordering.order, ["parent", "child"])
})

test("V16.15 integration order: an explicit dependency order is honored within a depth", () => {
  const ordering = deterministicIntegrationOrder(
    [{ taskId: "z", dependsOn: [] }, { taskId: "y", dependsOn: [] }],
    { dependencyOrder: ["y", "z"] },
  )
  assert.deepEqual(ordering.order, ["y", "z"])
})

// ---------------------------------------------------------------------------
// real transaction
// ---------------------------------------------------------------------------

test("V16.15 transaction: two independent sandbox patches integrate transactionally", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const sandboxA = await createTaskSandbox(root, "alpha", "t1")
    const sandboxB = await createTaskSandbox(root, "beta", "t2")
    writeFileSync(path.join(sandboxA.dir, "lib", "alpha.mjs"), "export const alpha = 2\n", "utf8")
    writeFileSync(path.join(sandboxB.dir, "lib", "beta.mjs"), "export const beta = 2\n", "utf8")

    // Preflight alone must not mutate the root.
    const preflight = await preflightTaskSandbox(root, sandboxA.dir, { allowedFiles: ["lib/alpha.mjs"] })
    assert.equal(preflight.ok, true)
    assert.deepEqual(preflight.changed, ["lib/alpha.mjs"])
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)

    const result = await runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t1", sandboxDir: sandboxA.dir, wave: 0, writeFiles: ["lib/alpha.mjs"] },
        { taskId: "t2", sandboxDir: sandboxB.dir, wave: 0, writeFiles: ["lib/beta.mjs"] },
      ],
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.INTEGRATED)
    assert.equal(result.rootUnchanged, false)
    assert.equal(result.applied.length, 2)
    assert.deepEqual(result.changedFiles, ["lib/alpha.mjs", "lib/beta.mjs"])
    assert.equal(result.rootVerificationRequired, true)
    assert.equal(result.cacheInvalidationRequired, true)
    assert.equal(result.canProduceVerdict, false)

    assert.equal(readNormalized(path.join(root, "lib", "alpha.mjs")), "export const alpha = 2\n")
    assert.equal(readNormalized(path.join(root, "lib", "beta.mjs")), "export const beta = 2\n")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: preflight-ALL happens before the first root mutation", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const good = await createTaskSandbox(root, "good", "t1")
    const bad = await createTaskSandbox(root, "bad", "t2")
    writeFileSync(path.join(good.dir, "lib", "alpha.mjs"), "export const alpha = 9\n", "utf8")
    writeFileSync(path.join(bad.dir, "lib", "beta.mjs"), "export const beta = 9\n", "utf8")

    // The bad patch declares a write scope it does not satisfy.
    const result = await runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t1", sandboxDir: good.dir, wave: 0, writeFiles: ["lib/alpha.mjs"] },
        { taskId: "t2", sandboxDir: bad.dir, wave: 0, writeFiles: ["lib/unrelated.mjs"] },
      ],
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rootUnchanged, true)
    assert.deepEqual(result.applied, [])
    assert.equal(result.rejected.length, 1)
    assert.equal(result.rejected[0].taskId, "t2")
    assert.equal(result.rejected[0].reason, "scope-violation")
    // The GOOD patch was refused too: the wave is all-or-nothing.
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
    assert.equal(readNormalized(path.join(root, "lib", "alpha.mjs")), "export const alpha = 1\n")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: a child-child patch collision is detected pre-apply", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const a = await createTaskSandbox(root, "coll-a", "t1")
    const b = await createTaskSandbox(root, "coll-b", "t2")
    // Both sandboxes rewrite the SAME file. Each applies cleanly on its own, so
    // only a wave-level collision check can catch it before root mutation.
    writeFileSync(path.join(a.dir, "lib", "alpha.mjs"), "export const alpha = 'from-a'\n", "utf8")
    writeFileSync(path.join(b.dir, "lib", "alpha.mjs"), "export const alpha = 'from-b'\n", "utf8")

    const result = await runIntegrationTransaction({
      root,
      patches: [
        { taskId: "t1", sandboxDir: a.dir, wave: 0, writeFiles: ["lib/alpha.mjs"] },
        { taskId: "t2", sandboxDir: b.dir, wave: 0, writeFiles: ["lib/alpha.mjs"] },
      ],
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rootUnchanged, true)
    assert.equal(result.collisions.length, 1)
    assert.equal(result.collisions[0].file, "lib/alpha.mjs")
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: a root that advanced since the wave started blocks a stale apply", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "stale", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 7\n", "utf8")

    const waveHead = rootWorkspaceIdentity(root).head
    // The root advances after the wave started.
    writeFileSync(path.join(root, "README.md"), "# repo\n\nchanged\n", "utf8")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "root moved"])

    const result = await runIntegrationTransaction({
      root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
      options: { expectedRootHead: waveHead },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rootUnchanged, true)
    assert.equal(result.rejected[0].reason, "root-advanced-since-wave-start")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: a sandbox whose base is stale against the wave base is refused", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "oldbase", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 8\n", "utf8")
    const preflight = await preflightTaskSandbox(root, sandbox.dir, { expectedBaseSha: "0000000000000000000000000000000000000000" })
    assert.equal(preflight.ok, false)
    assert.equal(preflight.reason, "stale-generation")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: dry run preflights everything and mutates nothing", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const sandbox = await createTaskSandbox(root, "dry", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 5\n", "utf8")

    const result = await runIntegrationTransaction({
      root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
      options: { dryRun: true },
    })
    assert.equal(result.dryRun, true)
    assert.equal(result.rootUnchanged, true)
    assert.deepEqual(result.applied, [])
    assert.equal(result.preflight[0].ok, true)
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: an empty patch set is a clean no-op", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const result = await runIntegrationTransaction({ root, patches: [] })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.NOTHING_TO_INTEGRATE)
    assert.equal(result.rootUnchanged, true)
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: an unchanged sandbox integrates as an empty patch", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const sandbox = await createTaskSandbox(root, "empty", "t1")
    const result = await runIntegrationTransaction({
      root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.INTEGRATED)
    assert.equal(result.changedFiles.length, 0)
    assert.equal(result.rootVerificationRequired, false)
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: a sandbox owned by a different root is refused", async () => {
  const first = makeRepo()
  const second = makeRepo()
  try {
    const sandbox = await createTaskSandbox(first.root, "foreign", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 3\n", "utf8")
    const result = await runIntegrationTransaction({
      root: second.root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rootUnchanged, true)
    assert.ok(["owner-root-mismatch", "preflight-threw", "sandbox-does-not-exist"].includes(result.rejected[0].reason))
  } finally {
    cleanup(first.base)
    cleanup(second.base)
  }
})

test("V16.15 transaction: a sandbox run identity mismatch is refused", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "runid", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 4\n", "utf8")
    const result = await runIntegrationTransaction({
      root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
      options: { expectedRunId: "run-does-not-match" },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rejected[0].reason, "run-mismatch")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: sandbox metadata is readable without mutation", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "meta", "t1")
    const ownerRoot = await taskSandboxOwnerRoot(sandbox.dir)
    assert.equal(path.resolve(ownerRoot), path.resolve(root))
    // Reading the metadata must not have created anything new in the root.
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    assert.equal(status, "")
  } finally {
    cleanup(base)
  }
})

test("V16.15 transaction: rollback leaves the root byte-identical", async () => {
  const { base, root } = makeRepo()
  try {
    const before = rootWorkspaceIdentity(root)
    const sandbox = await createTaskSandbox(root, "rollback", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 999\n", "utf8")
    const { rollbackTaskSandbox } = await import("../lib/worktree-sandbox.mjs")
    await runIntegrationTransaction({
      root,
      patches: [{ taskId: "t1", sandboxDir: sandbox.dir, wave: 0 }],
    })
    assert.equal(readNormalized(path.join(root, "lib", "alpha.mjs")), "export const alpha = 999\n")
    await rollbackTaskSandbox(root, sandbox.dir, { keep: true })
    const after = rootWorkspaceIdentity(root)
    assert.equal(after.identity, before.identity)
    assert.equal(readNormalized(path.join(root, "lib", "alpha.mjs")), "export const alpha = 1\n")
  } finally {
    cleanup(base)
  }
})

test("V16.15 preflight: a forbidden UES runtime path is refused", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "forbidden", "t1")
    mkdirSync(path.join(sandbox.dir, ".ues-cache"), { recursive: true })
    writeFileSync(path.join(sandbox.dir, ".ues-cache", "leak.json"), "{}\n", "utf8")
    const preflight = await preflightTaskSandbox(root, sandbox.dir)
    assert.equal(preflight.ok, false)
    assert.equal(preflight.reason, "forbidden-path")
  } finally {
    cleanup(base)
  }
})

test("V16.15 preflight: a missing sandbox is refused without throwing", async () => {
  const { base, root } = makeRepo()
  try {
    const preflight = await preflightTaskSandbox(root, path.join(base, "does-not-exist"))
    assert.equal(preflight.ok, false)
    assert.equal(preflight.reason, "sandbox-missing")
  } finally {
    cleanup(base)
  }
})

test("V16.15 preflight: preflight reports every check it performed", async () => {
  const { base, root } = makeRepo()
  try {
    const sandbox = await createTaskSandbox(root, "checks", "t1")
    writeFileSync(path.join(sandbox.dir, "lib", "alpha.mjs"), "export const alpha = 6\n", "utf8")
    const preflight = await preflightTaskSandbox(root, sandbox.dir)
    assert.equal(preflight.ok, true)
    const names = preflight.checks.map((row) => row.check)
    for (const required of [
      "sandbox-exists",
      "sandbox-is-worktree-root",
      "sandbox-metadata",
      "sandbox-owner-root",
      "integration-base",
      "changed-files",
      "no-forbidden-path",
      "no-root-overlap",
      "patch-generatable",
      "patch-applies-cleanly",
    ]) {
      assert.ok(names.includes(required), `missing preflight check ${required}`)
    }
  } finally {
    cleanup(base)
  }
})

// ---------------------------------------------------------------------------
// failure classification / retry / cancellation
// ---------------------------------------------------------------------------

test("V16.15 failure: timeout and hang are classified and retryable", () => {
  assert.equal(classifyChildFailure({ stopReason: "timeout" }).class, FAILURE_CLASS.TIMEOUT)
  assert.equal(classifyChildFailure({ stopReason: "timeout" }).retryable, true)
  assert.equal(classifyChildFailure({ stopReason: "inactivity" }).class, FAILURE_CLASS.PROCESS_HANG)
})

test("V16.15 failure: a stale result is never retryable", () => {
  const classification = classifyChildFailure({ stale: true })
  assert.equal(classification.class, FAILURE_CLASS.STALE)
  assert.equal(classification.retryable, false)
})

test("V16.15 failure: a policy block is never retryable", () => {
  const classification = classifyChildFailure({ error: "destructive command blocked by safety policy" })
  assert.equal(classification.class, FAILURE_CLASS.POLICY_BLOCK)
  assert.equal(classification.retryable, false)
})

test("V16.15 failure: a test failure and an implementation failure are distinguished", () => {
  assert.equal(classifyChildFailure({ error: "AssertionError: expected 2 but got 1" }).class, FAILURE_CLASS.TEST_FAILURE)
  assert.equal(classifyChildFailure({ exitCode: 2, error: "tool crashed" }).class, FAILURE_CLASS.IMPLEMENTATION_FAILURE)
})

test("V16.15 retry: at most one automatic retry per task", () => {
  const first = decideRetry({ classification: classifyChildFailure({ exitCode: 1, error: "tool crashed" }), attempts: 0 })
  assert.equal(first.retry, true)
  assert.equal(first.nextAttempt, 1)

  const second = decideRetry({
    classification: classifyChildFailure({ exitCode: 1, error: "tool crashed" }),
    attempts: 1,
    fingerprint: "fp-1",
    seenFingerprints: [],
  })
  assert.equal(second.retry, false)
  assert.equal(second.escalate, true)
})

test("V16.15 retry: the same failure fingerprint is never retried", () => {
  const decision = decideRetry({
    classification: classifyChildFailure({ exitCode: 1, error: "tool crashed" }),
    attempts: 0,
    fingerprint: "same-fingerprint",
    seenFingerprints: ["same-fingerprint"],
  })
  assert.equal(decision.retry, false)
  assert.equal(decision.escalate, true)
  assert.match(decision.reason, /identical failure fingerprint/)
})

test("V16.15 retry: a non-retryable failure never retries, even with budget left", () => {
  const decision = decideRetry({
    classification: classifyChildFailure({ error: "policy blocked the write" }),
    attempts: 0,
  })
  assert.equal(decision.retry, false)
  assert.equal(decision.escalate, true)
})

test("V16.15 cancellation: one failed child cancels dependents but NOT independent siblings", () => {
  const tasks = [
    { id: "t1" },
    { id: "t2", dependsOn: ["t1"] },
    { id: "t3", dependsOn: ["t2"] },
    { id: "independent" },
  ]
  const plan = planFailureCancellation({ failedTaskId: "t1", tasks })
  assert.deepEqual(plan.cancel, ["t2", "t3"])
  assert.deepEqual(plan.preserve, ["independent"])
  assert.equal(plan.cancelAll, false)
})

test("V16.15 cancellation: a failure with no dependents preserves every sibling", () => {
  const plan = planFailureCancellation({
    failedTaskId: "t1",
    tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
  })
  assert.deepEqual(plan.cancel, [])
  assert.deepEqual(plan.preserve, ["t2", "t3"])
})

test("V16.15 cancellation: only a shared-assumption invalidation cancels the whole wave", () => {
  const tasks = [{ id: "t1" }, { id: "t2" }, { id: "t3" }]
  const plan = planFailureCancellation({ failedTaskId: "t1", tasks, invalidatesSharedAssumptions: true })
  assert.equal(plan.cancelAll, true)
  assert.deepEqual(plan.cancel, ["t1", "t2", "t3"])
  assert.deepEqual(plan.preserve, [])
})

// ---------------------------------------------------------------------------
// progress watchdog + completion
// ---------------------------------------------------------------------------

test("V16.15 watchdog: a repeating wave state stops the loop", () => {
  const watchdog = createProgressWatchdog({ maxWaves: 10 })
  assert.equal(watchdog.observe({ fingerprint: "state-a" }).continue, true)
  assert.equal(watchdog.observe({ fingerprint: "state-b" }).continue, true)
  const repeat = watchdog.observe({ fingerprint: "state-a" })
  assert.equal(repeat.continue, false)
  assert.equal(repeat.terminal, COMPLETION_STATE.BLOCKED)
  assert.match(repeat.reason, /not making progress/)
})

test("V16.15 watchdog: the wave budget is a hard stop", () => {
  const watchdog = createProgressWatchdog({ maxWaves: 2 })
  assert.equal(watchdog.observe({ fingerprint: "s1" }).continue, true)
  assert.equal(watchdog.observe({ fingerprint: "s2" }).continue, true)
  const third = watchdog.observe({ fingerprint: "s3" })
  assert.equal(third.continue, false)
  assert.equal(third.terminal, COMPLETION_STATE.BLOCKED)
})

test("V16.15 watchdog: distinct states never trip the loop guard", () => {
  const watchdog = createProgressWatchdog({ maxWaves: 20 })
  for (let index = 0; index < 10; index += 1) {
    assert.equal(watchdog.observe({ fingerprint: `state-${index}` }).continue, true)
  }
  const snapshot = watchdog.snapshot()
  assert.equal(snapshot.waves, 10)
  assert.equal(snapshot.repeatedStates, 0)
})

test("V16.15 completion: DONE requires requirements + verification + stability + audit", () => {
  const done = evaluateCompletion({
    requirementsTotal: 3,
    requirementsCovered: 3,
    verificationPassed: true,
    workspaceStable: true,
    completionAuditPassed: true,
  })
  assert.equal(done.state, COMPLETION_STATE.DONE)
})

test("V16.15 completion: missing verification is CONTINUE, never DONE", () => {
  const state = evaluateCompletion({
    requirementsTotal: 1,
    requirementsCovered: 1,
    verificationPassed: false,
  })
  assert.equal(state.state, COMPLETION_STATE.CONTINUE)
  assert.match(state.reason, /verification/)
})

test("V16.15 completion: an uncovered requirement is CONTINUE", () => {
  const state = evaluateCompletion({
    requirementsTotal: 3,
    requirementsCovered: 2,
    verificationPassed: true,
  })
  assert.equal(state.state, COMPLETION_STATE.CONTINUE)
  assert.match(state.reason, /2\/3/)
})

test("V16.15 completion: a blocker is BLOCKED with the exact blocker", () => {
  const state = evaluateCompletion({
    requirementsTotal: 1,
    requirementsCovered: 1,
    verificationPassed: true,
    blockers: ["worktree creation failed: disk full"],
  })
  assert.equal(state.state, COMPLETION_STATE.BLOCKED)
  assert.equal(state.blockers[0], "worktree creation failed: disk full")
})

test("V16.15 completion: cancellation is CANCELLED", () => {
  assert.equal(evaluateCompletion({ cancelled: true }).state, COMPLETION_STATE.CANCELLED)
})

test("V16.15 completion: only a genuine human decision yields NEEDS_USER_DECISION", () => {
  const state = evaluateCompletion({ userDecisionReason: "destructive-operation-approval" })
  assert.equal(state.state, COMPLETION_STATE.NEEDS_USER_DECISION)

  // An unrecognized reason is a BLOCK: the loop must not invent a question to
  // escape a hard problem.
  const fabricated = evaluateCompletion({ userDecisionReason: "planning finished" })
  assert.equal(fabricated.state, COMPLETION_STATE.BLOCKED)
  assert.match(fabricated.reason, /unrecognized user-decision reason/)
})

test("V16.15 completion: internal lifecycle events never stop the loop", () => {
  for (const phase of ["planning finished", "child finished", "tests finished", "ready to integrate"]) {
    const state = evaluateCompletion({
      requirementsTotal: 2,
      requirementsCovered: 1,
      verificationPassed: false,
      userDecisionReason: phase,
    })
    assert.notEqual(state.state, COMPLETION_STATE.NEEDS_USER_DECISION)
    assert.equal(state.state, COMPLETION_STATE.BLOCKED)
  }
})

test("V16.15 completion: a pending task keeps the loop going", () => {
  const state = evaluateCompletion({
    requirementsTotal: 1,
    requirementsCovered: 1,
    verificationPassed: true,
    pendingTasks: 2,
  })
  assert.equal(state.state, COMPLETION_STATE.CONTINUE)
})

test("V16.15 completion: an unstable workspace is CONTINUE", () => {
  const state = evaluateCompletion({
    requirementsTotal: 1,
    requirementsCovered: 1,
    verificationPassed: true,
    workspaceStable: false,
  })
  assert.equal(state.state, COMPLETION_STATE.CONTINUE)
  assert.match(state.reason, /not stable/)
})
