import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { runProcess } from "../lib/process-runner.mjs"
import { buildVerificationReceipt } from "../lib/verification-receipt.mjs"
import { recommendExecutionPolicy } from "../lib/orchestrator-policy.mjs"
import { buildLearningProposals, writeLearningBundle } from "../lib/learning-engine.mjs"
import { buildHermesHandoff } from "../lib/hermes-bridge.mjs"
import { buildContextManifest } from "../lib/context-intelligence.mjs"
import {
  applyTaskSandbox,
  createTaskSandbox,
  removeTaskSandbox,
  taskSandboxPath,
} from "../lib/worktree-manager.mjs"
import { collectControlCenterState } from "../lib/control-center.mjs"
import {
  approvePlan,
  completeTask,
  importPlan,
  initWork,
  recordIntegrationVerification,
  recordVerificationReceipt,
  recoverStaleTasks,
  startTask,
  workspaceFingerprint,
} from "../lib/task-engine.mjs"

function git(root, args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr || run.stdout)
}

async function initGit(root) {
  git(root, ["init"])
  git(root, ["config", "user.name", "UES Test"])
  git(root, ["config", "user.email", "ues@example.invalid"])
  await writeFile(path.join(root, "README.md"), "fixture\n", "utf8")
  git(root, ["add", "."])
  git(root, ["commit", "-m", "fixture"])
}

const plan = {
  schemaVersion: 1,
  goal: "V7 strict work",
  tasks: [{
    id: "T1",
    title: "One",
    summary: "Change one file",
    files: { modify: ["README.md"] },
    dependsOn: [],
    acceptance: ["README remains valid"],
    verification: ["node -e process.exit(0)"],
    risk: "medium",
  }],
}

test("async process runner returns output and enforces timeout", async () => {
  const ok = await runProcess(process.execPath, ["-e", "console.log('ok')"], { timeoutMs: 5000 })
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /ok/)

  const timed = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 50 })
  assert.notEqual(timed.status, 0)
  assert.equal(timed.timedOut, true)
})

test("adaptive policy raises riskier work and structured receipts are deterministic", () => {
  const low = recommendExecutionPolicy({ risk: "low", files: 1, contextBytes: 1000, attempt: 1 })
  const high = recommendExecutionPolicy({ risk: "critical", files: 10, contextBytes: 70000, attempt: 3 })
  assert.equal(low.recommendedTier, "light")
  assert.equal(high.recommendedTier, "heavy")
  assert.equal(high.isolationRecommended, true)

  const receipt = buildVerificationReceipt({
    command: "npm test",
    exitCode: 0,
    startedAt: "2026-09-20T00:00:00Z",
    finishedAt: "2026-09-20T00:00:01Z",
    stdout: "pass",
    stderr: "",
    workspaceFingerprint: "abc",
  })
  assert.equal(receipt.passed, true)
  assert.equal(receipt.stdoutHash.length, 64)
})

test("context intelligence includes declared files, import neighborhood and excerpts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-v7-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "src", "a.mjs"), "import './b.mjs'\nexport const a=1\n", "utf8")
    await writeFile(path.join(root, "src", "b.mjs"), "export const b=2\n", "utf8")
    await writeFile(path.join(root, "test", "a.test.mjs"), "import '../src/a.mjs'\n", "utf8")
    const manifest = await buildContextManifest(root, {
      id: "T",
      files: { modify: ["src/a.mjs"] },
    })
    assert.deepEqual(manifest.declaredFiles, ["src/a.mjs"])
    assert.ok(manifest.dependencyNeighborhood.includes("src/b.mjs") || manifest.dependencyNeighborhood.includes("test/a.test.mjs"))
    assert.match(manifest.excerpts["src/a.mjs"], /export const a/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("strict work recovers stale leases and requires machine-bound verification receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-receipt-v7-"))
  try {
    await initGit(root)
    await initWork(root, "strict-work", plan.goal, { requireReceipts: true })
    const planFile = path.join(root, "plan.json")
    await writeFile(planFile, JSON.stringify(plan), "utf8")
    await importPlan(root, "strict-work", planFile)
    await approvePlan(root, "strict-work", "checker PASS")

    const first = await startTask(root, "strict-work", "T1", { leaseMs: 30_000 })
    const recovered = await recoverStaleTasks(root, "strict-work", {
      nowMs: Date.parse(first.record.leaseExpiresAt) + 1,
    })
    assert.deepEqual(recovered.recovered, ["T1"])

    const second = await startTask(root, "strict-work", "T1")
    await assert.rejects(
      completeTask(root, "strict-work", "T1", { evidence: "narrative only", runId: second.record.runId }),
      /structured verification receipt/,
    )

    const taskReceipt = buildVerificationReceipt({
      command: "node -e process.exit(0)",
      exitCode: 0,
      startedAt: new Date(Date.now() - 10).toISOString(),
      finishedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      workspaceFingerprint: workspaceFingerprint(root),
      runId: second.record.runId,
    })
    await recordVerificationReceipt(root, "strict-work", "T1", taskReceipt)
    await completeTask(root, "strict-work", "T1", {
      evidence: "machine receipt PASS",
      runId: second.record.runId,
    })

    const integrationReceipt = buildVerificationReceipt({
      scope: "integration",
      command: "node -e process.exit(0)",
      exitCode: 0,
      startedAt: new Date(Date.now() - 10).toISOString(),
      finishedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      workspaceFingerprint: workspaceFingerprint(root),
    })
    await recordVerificationReceipt(root, "strict-work", "__integration__", integrationReceipt)
    const verified = await recordIntegrationVerification(root, "strict-work", "PASS", "integration verifier PASS")
    assert.equal(verified.status, "PASS")

    const events = await readFile(path.join(root, ".ues-work", "strict-work", "EVENTS.jsonl"), "utf8")
    assert.match(events, /task\.stale-recovered/)
    assert.match(events, /verification\.receipt/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("isolated Git task sandbox can apply a patch back to the integration worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-v7-"))
  try {
    await initGit(root)
    const sandbox = await createTaskSandbox(root, "demo", "T1")
    await writeFile(path.join(sandbox.dir, "README.md"), "changed in sandbox\n", "utf8")
    const applied = applyTaskSandbox(root, "demo", "T1")
    assert.equal(applied.applied, true)
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "changed in sandbox\n")
    await removeTaskSandbox(root, "demo", "T1", { force: true })
    assert.equal(taskSandboxPath(root, "demo", "T1"), sandbox.dir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("learning loop stays proposal-only and Hermes handoff preserves UES source of truth", async () => {
  const proposals = buildLearningProposals([
    { task: "a", model: "m", mode: "ues", agentExit: 0, graderExit: 1, orchestration: { required: true, valid: true } },
    { task: "b", model: "m", mode: "ues", agentExit: 0, graderExit: 1, orchestration: { required: true, valid: true } },
  ])
  assert.equal(proposals[0].signature, "behavior-correctness")
  assert.equal(proposals[0].activation, "proposal-only")

  const handoff = buildHermesHandoff({ slug: "x", task: { id: "T1" }, spec: "goal" })
  assert.equal(handoff.payload.source, "ues")
  assert.equal(handoff.payload.target, "hermes-agent")

  const root = await mkdtemp(path.join(os.tmpdir(), "ues-learning-v7-"))
  try {
    await mkdir(path.join(root, ".ues-evals"), { recursive: true })
    await writeFile(path.join(root, ".ues-evals", "run.json"), JSON.stringify({ results: [
      { task: "a", model: "m", mode: "baseline", agentExit: 1, graderExit: 1 },
    ] }), "utf8")
    const bundle = await writeLearningBundle(root)
    assert.equal(bundle.proposals[0].signature, "runtime-exit")
    const dashboard = await collectControlCenterState(root)
    assert.equal(dashboard.learning.policy.includes("proposal-only"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
