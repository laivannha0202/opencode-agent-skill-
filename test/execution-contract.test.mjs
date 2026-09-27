import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildExecutionContract,
  buildFinalVerdictMatrix,
  captureInheritedDirtyState,
  crossToolTempPathRisk,
  detectInheritedDirtyViolations,
  enforcePhaseGates,
  explicitlyAuthorizedInheritedDirtyPaths,
  extractExplicitPhases,
  isLocalEnvPath,
  localEnvWriteRisk,
  taskExplicitlyAllowsLocalEnvWrite,
} from "../lib/execution-contract.mjs"
import { destructiveShellRisk } from "../lib/safety.mjs"

test("V15.16 Windows file tools reject ambiguous POSIX temp paths", () => {
  assert.deepEqual(
    crossToolTempPathRisk("/tmp/head.ts", "win32"),
    { risky: true, id: "cross-tool-posix-temp-path", path: "/tmp/head.ts" },
  )
  assert.deepEqual(
    crossToolTempPathRisk("/var/tmp/detection.ts", "win32"),
    { risky: true, id: "cross-tool-posix-temp-path", path: "/var/tmp/detection.ts" },
  )
  assert.equal(crossToolTempPathRisk(".ues-cache/tmp/head.ts", "win32").risky, false)
  assert.equal(crossToolTempPathRisk("/tmp/head.ts", "linux").risky, false)
})

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

test("V15.15 inherited dirty guard ignores UES/generated artifacts and detects unauthorized mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-dirty-guard-"))
  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr || init.stdout)

    await mkdir(path.join(root, ".ues-traces"), { recursive: true })
    await mkdir(path.join(root, "apps", "mobile", ".next-desktop"), { recursive: true })
    await writeFile(path.join(root, ".ues-traces", "trace.jsonl"), "{}\n", "utf8")
    await writeFile(path.join(root, "apps", "mobile", ".next-desktop", "cache.bin"), "cache", "utf8")
    await writeFile(path.join(root, "important.ts"), "const value = 1\n", "utf8")

    const snapshot = captureInheritedDirtyState(root)
    assert.deepEqual(snapshot.paths, ["important.ts"])
    assert.equal(snapshot.entries[0]?.state?.kind, "file")
    assert.match(String(snapshot.entries[0]?.state?.hash || ""), /^[a-f0-9]{64}$/)

    const approvedNone = explicitlyAuthorizedInheritedDirtyPaths(
      "Audit important.ts but do not modify important.ts.",
      snapshot.paths,
    )
    assert.deepEqual(approvedNone, [])

    await writeFile(path.join(root, "important.ts"), "const value = 2\n", "utf8")
    const violation = detectInheritedDirtyViolations(root, snapshot, approvedNone)
    assert.equal(violation.safe, false)
    assert.equal(violation.reason, "inherited-dirty-work-modified")
    assert.deepEqual(violation.violations.map((item) => item.path), ["important.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.15 inherited dirty guard permits only explicit mutation scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-dirty-approved-"))
  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr || init.stdout)
    await writeFile(path.join(root, "src.ts"), "export const n = 1\n", "utf8")
    const snapshot = captureInheritedDirtyState(root)
    const approved = explicitlyAuthorizedInheritedDirtyPaths(
      "Fix src.ts so the exported value is correct.",
      snapshot.paths,
    )
    assert.deepEqual(approved, ["src.ts"])
    await writeFile(path.join(root, "src.ts"), "export const n = 2\n", "utf8")
    assert.equal(detectInheritedDirtyViolations(root, snapshot, approved).safe, true)
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

test("V15.15 constraint-only phases remain invariants instead of fake tasks", () => {
  const contract = buildExecutionContract([
    "PHASE 0 — Audit",
    "Inspect.",
    "PHASE 1 — TUYỆT ĐỐI KHÔNG ĐƯỢC LÀM",
    "TUYỆT ĐỐI KHÔNG: reset hard, frontend filtering.",
    "PHASE 2 — Fix",
    "Implement.",
  ].join("\n"))
  assert.deepEqual(
    contract.phases.map((phase) => [phase.number, phase.kind]),
    [[0, "execution"], [1, "constraint"], [2, "execution"]],
  )

  const plan = {
    schemaVersion: 1,
    goal: "audit then fix",
    tasks: [
      {
        id: "audit",
        phase: 0,
        title: "Audit",
        summary: "Inspect",
        dependsOn: [],
        files: { read: ["a.ts"], create: [], modify: [], test: [], delete: [] },
        acceptance: ["audited"],
        verification: ["inspect"],
        risk: "low",
      },
      {
        id: "fix",
        phase: 2,
        title: "Fix",
        summary: "Implement",
        dependsOn: [],
        files: { read: [], create: [], modify: ["a.ts"], test: [], delete: [] },
        acceptance: ["fixed"],
        verification: ["test"],
        risk: "medium",
      },
    ],
  }
  const gated = enforcePhaseGates(plan, contract)
  assert.equal(gated.valid, true, gated.errors.join("\n"))
  assert.deepEqual(gated.plan.phaseGate.orderedPhases, [0, 2])
  assert.deepEqual(gated.plan.tasks.find((task) => task.id === "fix").dependsOn, ["audit"])

  const bad = enforcePhaseGates({
    ...plan,
    tasks: [...plan.tasks, {
      id: "fake-guardrail-task",
      phase: 1,
      title: "Fake guardrail",
      summary: "Should not exist",
      dependsOn: [],
      files: { read: ["a.ts"], create: [], modify: [], test: [], delete: [] },
      acceptance: ["n/a"],
      verification: ["n/a"],
      risk: "low",
    }],
  }, contract)
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((item) => /unknown phase 1/.test(item)))
})

test("V15.15 generic inspection wording does not force runtime proof", () => {
  const contract = buildExecutionContract("Kiểm tra source hiện tại và báo cáo cấu trúc repository.")
  assert.equal(contract.gates.runtime, false)
  const testContract = buildExecutionContract("Chạy pnpm test, typecheck và runtime smoke.")
  assert.equal(testContract.gates.runtime, true)
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

  const missingDb = buildFinalVerdictMatrix(task, {
    contract,
    primaryPass: true,
    integrationPass: true,
    integrationOutput: "cleanup started but idempotency/count evidence is missing",
    integrationChecks: "pnpm test\npnpm runtime:smoke",
  })
  assert.equal(missingDb.source, "SOURCE_PASS")
  assert.equal(missingDb.runtime, "RUNTIME_PASS")
  assert.equal(missingDb.dbClean, "DB_CLEAN_NOT_VERIFIED")
  assert.equal(missingDb.device, "DEVICE_NOT_VERIFIED")
  assert.equal(missingDb.final, "PARTIAL_OR_NOT_VERIFIED")

  const complete = buildFinalVerdictMatrix(task, {
    contract,
    primaryPass: true,
    integrationPass: true,
    integrationOutput: "DB_CLEAN_PASS\nRUNTIME_PASS\ncleanup dry-run removed count=12; second cleanup run idempotent count=0",
    visualOutput: "DEVICE_PASS — Expo Go real device verified",
    integrationChecks: "pnpm test\npnpm cleanup --dry-run",
    visualChecks: "adb devices\nExpo Go physical device interaction verified",
  })
  assert.equal(complete.final, "PASS")
})

test("V15.15 safety blocks inherited-work discard commands", () => {
  assert.equal(destructiveShellRisk("git restore package-lock.json").risky, true)
  assert.equal(destructiveShellRisk("git checkout -- src/app.ts").risky, true)
  assert.equal(destructiveShellRisk("git stash push -m temp").risky, true)
  assert.equal(destructiveShellRisk("git status --short").risky, false)
})
