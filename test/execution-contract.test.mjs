import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildExecutionContract,
  buildFinalVerdictMatrix,
  captureInheritedDirtyState,
  enforcePhaseGates,
  extractExplicitPhases,
  isLocalEnvPath,
  localEnvWriteRisk,
  taskExplicitlyAllowsLocalEnvWrite,
} from "../lib/execution-contract.mjs"
import { destructiveShellRisk } from "../lib/safety.mjs"

test("V15.15 local env guard distinguishes runtime inputs from templates", () => {
  assert.equal(isLocalEnvPath(".env"), true)
  assert.equal(isLocalEnvPath("apps/api/.env.local"), true)
  assert.equal(isLocalEnvPath(".env.development"), true)
  assert.equal(isLocalEnvPath(".env.example"), false)
  assert.equal(isLocalEnvPath("apps/api/.env.sample"), false)

  assert.equal(localEnvWriteRisk("echo X=1 > .env").risky, true)
  assert.equal(localEnvWriteRisk("Set-Content .env.local 'X=1'").risky, true)
  assert.equal(localEnvWriteRisk("echo X=1 > .env.example").risky, false)
  assert.equal(localEnvWriteRisk("node -e \"require('fs').writeFileSync('.env','X=1')\"").risky, true)

  assert.equal(
    taskExplicitlyAllowsLocalEnvWrite("Kiểm tra README và .env.example; không sửa file local."),
    false,
  )
  assert.equal(
    taskExplicitlyAllowsLocalEnvWrite("Không sửa .env; chỉ cập nhật .env.example."),
    false,
  )
  assert.equal(
    taskExplicitlyAllowsLocalEnvWrite("Hãy sửa .env.local trên máy này để thêm TEST_DATABASE_URL."),
    true,
  )
})

test("V15.15 inherited dirty snapshot records pre-existing work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-dirty-contract-"))
  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr || init.stdout)
    await writeFile(path.join(root, "existing.txt"), "work in progress\n", "utf8")
    const snapshot = captureInheritedDirtyState(root)
    assert.equal(snapshot.available, true)
    assert.equal(snapshot.clean, false)
    assert.ok(snapshot.paths.includes("existing.txt"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.15 explicit phases become deterministic previous-phase barriers", () => {
  const prompt = [
    "PHASE 0 — AUDIT SOURCE",
    "Inspect baseline.",
    "PHASE 1 — DATABASE ISOLATION",
    "Separate test DB.",
    "PHASE 2 — CLEANUP",
    "Clean deterministic fixtures.",
  ].join("\n")
  const phases = extractExplicitPhases(prompt)
  assert.deepEqual(phases.map((item) => item.number), [0, 1, 2])

  const contract = buildExecutionContract(prompt, {
    schemaVersion: 1,
    available: true,
    clean: true,
    paths: [],
    entries: [],
  })
  const plan = {
    schemaVersion: 1,
    goal: "audit and cleanup",
    tasks: [
      {
        id: "audit",
        phase: 0,
        title: "Audit",
        summary: "Audit baseline",
        dependsOn: [],
        files: { read: ["README.md"], create: [], modify: [], test: [], delete: [] },
        acceptance: ["baseline recorded"],
        verification: ["git status"],
        risk: "low",
      },
      {
        id: "isolate",
        phase: 1,
        title: "Isolation",
        summary: "Separate test DB",
        dependsOn: [],
        files: { read: [], create: [], modify: [".env.example"], test: [], delete: [] },
        acceptance: ["test DB isolated"],
        verification: ["unit test"],
        risk: "medium",
      },
      {
        id: "cleanup",
        phase: 2,
        title: "Cleanup",
        summary: "Cleanup fixtures",
        dependsOn: [],
        files: { read: [], create: [], modify: ["cleanup.mjs"], test: [], delete: [] },
        acceptance: ["fixtures removed"],
        verification: ["cleanup dry-run"],
        risk: "medium",
      },
    ],
  }

  const gated = enforcePhaseGates(plan, contract)
  assert.equal(gated.valid, true, gated.errors.join("\n"))
  const isolate = gated.plan.tasks.find((item) => item.id === "isolate")
  const cleanup = gated.plan.tasks.find((item) => item.id === "cleanup")
  assert.deepEqual(isolate.dependsOn, ["audit"])
  assert.ok(cleanup.dependsOn.includes("isolate"))
  assert.equal(gated.plan.phaseGate.barrierStrategy, "previous-phase-all-tasks")
})

test("V15.15 phase gate fails closed when a declared phase is omitted", () => {
  const contract = buildExecutionContract("PHASE 0 — Audit\nA\nPHASE 1 — Fix\nB")
  const gated = enforcePhaseGates({
    schemaVersion: 1,
    goal: "x",
    tasks: [{
      id: "audit",
      phase: 0,
      title: "Audit",
      summary: "Audit",
      dependsOn: [],
      files: { read: ["a"], create: [], modify: [], test: [], delete: [] },
      acceptance: ["a"],
      verification: ["a"],
      risk: "low",
    }],
  }, contract)
  assert.equal(gated.valid, false)
  assert.ok(gated.errors.some((item) => /PHASE 1 has no planned task/.test(item)))
})

test("V15.15 final verdict matrix separates source runtime data and device proof", () => {
  const task = [
    "Cleanup fixture database and run e2e runtime smoke.",
    "PHASE 16 — MANUAL MOBILE ACCEPTANCE",
    "Test Expo Go on a real device.",
  ].join("\n")
  const contract = buildExecutionContract(task)
  const partial = buildFinalVerdictMatrix(task, {
    contract,
    primaryPass: true,
    integrationPass: true,
    integrationOutput: "DB_CLEAN_PASS\ncleanup dry-run removed count=12; second cleanup run idempotent count=0",
    integrationChecks: "pnpm test\npnpm runtime:smoke\npnpm cleanup --dry-run",
  })
  assert.equal(partial.source, "SOURCE_PASS")
  assert.equal(partial.runtime, "RUNTIME_PASS")
  assert.equal(partial.dbClean, "DB_CLEAN_PASS")
  assert.equal(partial.device, "DEVICE_NOT_VERIFIED")
  assert.equal(partial.final, "SOURCE_RUNTIME_PASS_DEVICE_NOT_VERIFIED")

  const complete = buildFinalVerdictMatrix(task, {
    contract,
    primaryPass: true,
    integrationPass: true,
    integrationOutput: "DB_CLEAN_PASS\nRUNTIME_PASS\ncleanup dry-run removed count=12; second cleanup run idempotent count=0",
    visualOutput: "DEVICE_PASS — Expo Go real device verified",
    integrationChecks: "pnpm test\npnpm cleanup --dry-run",
  })
  assert.equal(complete.final, "PASS")
})

test("V15.15 safety blocks inherited-work discard commands", () => {
  assert.equal(destructiveShellRisk("git restore package-lock.json").risky, true)
  assert.equal(destructiveShellRisk("git checkout -- src/app.ts").risky, true)
  assert.equal(destructiveShellRisk("git stash push -m temp").risky, true)
  assert.equal(destructiveShellRisk("git status --short").risky, false)
})
