import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { adaptiveContextBudget } from "../lib/adaptive-context-budget.mjs"
import { clearSkillCompilerCache, compileSkillContext, selectSkillNames } from "../lib/skill-compiler.mjs"
import { clearAffectedTestCache, resolveAffectedTests } from "../lib/affected-tests.mjs"
import { findReusableVerification, listReusableVerification, recordVerification } from "../lib/verification-broker.mjs"
import { runtimeWorkspaceFingerprint, runtimeWorkspaceSnapshot } from "../lib/workspace-fingerprint.mjs"
import { runSupervisedProcess } from "../lib/process-supervisor.mjs"
import { selectBrowserToolsForTask } from "../lib/browser-mcp-routing.mjs"
import { rankContextGraph } from "../lib/context-graph-rank.mjs"
import { destructiveShellAnalysis, shellCommandSegments } from "../lib/safety.mjs"
import { getEvidenceSelected, putEvidence } from "../lib/evidence-store.mjs"
import { buildSemanticIndexCached, clearSemanticIndexRuntimeCache } from "../lib/semantic-index.mjs"
import { buildRepoGraph } from "../lib/repo-graph.mjs"
import { PiRpcWorkerPool } from "../lib/pi-rpc-pool.mjs"
import {
  canRecordReusableVerification,
  canonicalVerificationCommand,
  hasMaskedShellExitRisk,
  looksLikeVerificationCommand,
} from "../lib/verification-command.mjs"

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function gitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v142-"))
  git(root, ["init"])
  git(root, ["config", "user.email", "ues@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  return root
}

test("V14.2 hot-path helper exports are live", async () => {
  assert.equal(typeof clearSkillCompilerCache, "function")
  assert.equal(typeof clearAffectedTestCache, "function")
  assert.equal(typeof runtimeWorkspaceSnapshot, "function")

  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const snapshot = runtimeWorkspaceSnapshot(root)
    assert.equal(snapshot.cacheable, true)
    assert.equal(snapshot.git, true)
    assert.equal(typeof snapshot.fingerprint, "string")
    assert.deepEqual(snapshot.changedFiles, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("adaptive context shrinks low-risk roles and expands after failure", () => {
  const policy = {
    executionProfile: "standard",
    risk: "low",
    contextBudget: 20_000,
    profile: { contextBudget: 20_000 },
  }
  assert.equal(adaptiveContextBudget(policy, "verifier", 1).budget, 8_000)
  assert.equal(adaptiveContextBudget(policy, "verifier", 2).budget, 12_000)
  assert.equal(adaptiveContextBudget(policy, "verifier", 3).budget, 20_000)

  const highRisk = { ...policy, risk: "high", contextBudget: 48_000, profile: { contextBudget: 48_000 } }
  assert.equal(adaptiveContextBudget(highRisk, "verifier", 1).budget, 48_000)

  const deep = {
    executionProfile: "deep",
    risk: "medium",
    contextBudget: 48_000,
    profile: { name: "deep", contextBudget: 48_000 },
  }
  assert.equal(adaptiveContextBudget(deep, "executor", 1).budget, 26_000)
  assert.equal(adaptiveContextBudget(deep, "executor", 2).budget, 39_000)
  assert.equal(adaptiveContextBudget(deep, "executor", 3).budget, 48_000)
})

test("micro-skill compiler selects bounded role/domain skills", async () => {
  const policy = { maxSkills: 3, domains: ["payment", "database"] }
  const selected = selectSkillNames(policy, "executor")
  assert.ok(selected.includes("implementation-engineer"))
  assert.ok(selected.includes("payment-engineering"))
  const compiled = await compileSkillContext(policy, "executor", { totalChars: 1800 })
  assert.ok(compiled.loaded.length >= 1)
  assert.ok(compiled.chars <= 1800)
  assert.ok(compiled.text.length <= 1800)
  assert.equal(compiled.cacheHit, false)

  const cached = await compileSkillContext(policy, "executor", { totalChars: 1800 })
  assert.deepEqual(cached.loaded, compiled.loaded)
  assert.equal(cached.text, compiled.text)
  assert.equal(cached.cacheHit, true)
})

test("affected-test resolver ranks a nearby referencing test", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src", "payment"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "jest" },
    }))
    await writeFile(path.join(root, "src", "payment", "refund.ts"), "export const refund = () => 1\n")
    await writeFile(path.join(root, "test", "refund.spec.ts"), "import { refund } from '../src/payment/refund'\ntest('refund',()=>refund())\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    await writeFile(path.join(root, "src", "payment", "refund.ts"), "export const refund = () => 2\n")

    const plan = await resolveAffectedTests(root, { limit: 5 })
    assert.equal(plan.changedFiles.includes("src/payment/refund.ts"), true)
    assert.equal(plan.tests[0]?.path, "test/refund.spec.ts")
    assert.ok(plan.tests[0]?.score > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verification broker reuses PASS only for unchanged workspace", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const fp = runtimeWorkspaceFingerprint(root)
    await recordVerification(root, {
      command: process.execPath,
      args: ["--version"],
      exitCode: 0,
      stdout: process.version,
      stderr: "",
      workspaceBefore: fp,
      workspaceAfter: fp,
      durationMs: 1,
    })
    const reused = await findReusableVerification(root, process.execPath, ["--version"])
    assert.equal(reused?.receipt?.passed, true)

    await writeFile(path.join(root, "a.txt"), "two\n")
    const stale = await findReusableVerification(root, process.execPath, ["--version"])
    assert.equal(stale, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verification broker exact executable+args keys do not cross-reuse", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const fp = runtimeWorkspaceFingerprint(root)

    await recordVerification(root, {
      command: "pnpm",
      args: ["test", "--", "refund.spec.ts"],
      exitCode: 0,
      stdout: "PASS refund.spec.ts",
      stderr: "",
      workspaceBefore: fp,
      workspaceAfter: fp,
      durationMs: 1,
    })

    const exact = await findReusableVerification(
      root,
      "pnpm",
      ["test", "--", "refund.spec.ts"],
    )
    assert.equal(exact?.receipt?.passed, true)

    const different = await findReusableVerification(
      root,
      "pnpm",
      ["test", "--", "payment.spec.ts"],
    )
    assert.equal(different, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("process supervisor caps output and times out process trees", async () => {
  const output = await runSupervisedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
    stdoutLimit: 2048,
    hardTimeoutMs: 5_000,
  })
  assert.equal(output.exitCode, 0)
  assert.equal(output.stdout.length, 2048)
  assert.equal(output.stdoutTruncated, true)

  const hung = await runSupervisedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdoutLimit: 2048,
    hardTimeoutMs: 150,
    drainTimeoutMs: 200,
    killGraceMs: 50,
  })
  assert.equal(hung.stopReason, "hard-timeout")
})

test("POSIX supervisor escalates to surviving grandchildren after direct child exits", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group semantics only")
    return
  }

  const grandchildCode = [
    "process.on('SIGTERM',()=>{});",
    "setInterval(()=>{},1000);",
  ].join("")
  const parentCode = [
    "const {spawn}=require('node:child_process');",
    "const g=spawn(process.execPath,['-e'," + JSON.stringify(grandchildCode) + "],{stdio:['ignore','inherit','inherit']});",
    "console.log(g.pid);",
    "process.on('SIGTERM',()=>process.exit(0));",
    "setInterval(()=>{},1000);",
  ].join("")

  const result = await runSupervisedProcess(process.execPath, ["-e", parentCode], {
    stdoutLimit: 2048,
    hardTimeoutMs: 180,
    drainTimeoutMs: 800,
    killGraceMs: 80,
  })
  assert.equal(result.stopReason, "hard-timeout")
  const grandchildPid = Number(String(result.stdout || "").trim().split(/\s+/)[0])
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1)

  let alive = true
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(grandchildPid, 0)
    } catch {
      alive = false
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(alive, false, "grandchild survived process-group escalation")
})

test("browser task routing exposes a smaller task-specific subset", () => {
  const names = [
    "browser_snapshot", "browser_screenshot", "browser_console_messages",
    "browser_network_requests", "browser_navigate", "browser_click",
    "browser_fill_form", "browser_press_key", "browser_hover", "browser_evaluate",
    "browser_close", "browser_resize",
  ]
  const selected = selectBrowserToolsForTask(names, "verify responsive screenshot", "visual-verifier")
  assert.ok(selected.includes("browser_snapshot"))
  assert.ok(selected.includes("browser_screenshot"))
  assert.ok(selected.length <= 10)
  assert.ok(selected.length < names.length)
})

test("non-git runtime fingerprints fail closed instead of reusing stale cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v142-nongit-"))
  try {
    const first = runtimeWorkspaceFingerprint(root)
    const second = runtimeWorkspaceFingerprint(root)
    assert.notEqual(first, second)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("personalized graph ranking propagates semantic relevance through dependencies", () => {
  const graph = {
    nodes: [
      { path: "src/api.ts" },
      { path: "src/service.ts" },
      { path: "src/db.ts" },
      { path: "src/unrelated.ts" },
    ],
    edges: [
      { from: "src/api.ts", to: "src/service.ts", kind: "local-import" },
      { from: "src/service.ts", to: "src/db.ts", kind: "local-import" },
    ],
  }
  const ranked = rankContextGraph(graph, {
    semanticResults: [{ path: "src/api.ts", score: 20 }],
    declared: ["src/api.ts"],
    changed: [],
  })
  const service = ranked.find((item) => item.path === "src/service.ts")
  const unrelated = ranked.find((item) => item.path === "src/unrelated.ts")
  assert.ok(service)
  assert.ok(service.score > (unrelated?.score || 0))
})

test("shell safety inspects compound command segments without splitting quoted operators", () => {
  const segments = shellCommandSegments("echo 'a && b' && npm publish | cat")
  assert.equal(segments.length, 3)
  assert.equal(segments[0].text, "echo 'a && b'")
  const analysis = destructiveShellAnalysis("echo safe && npm publish | cat")
  assert.equal(analysis.risky, true)
  assert.equal(analysis.id, "publish")
  assert.equal(analysis.findings[0].segment, "npm publish")
})

test("selective evidence retrieval returns only the requested JSON subtree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v142-evidence-"))
  try {
    const stored = await putEvidence(root, {
      errors: [{ code: "E_ONE", message: "first" }, { code: "E_TWO", message: "second" }],
      meta: { ok: true },
    }, { kind: "test-json" })
    const selected = await getEvidenceSelected(root, stored.ref + "#/errors/1", { maxBytes: 4096 })
    assert.match(selected.content, /E_TWO/)
    assert.doesNotMatch(selected.content, /E_ONE/)
    assert.equal(selected.selector, "/errors/1")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("runtime fingerprint ignores UES internal state in target repositories", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "source.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const before = runtimeWorkspaceFingerprint(root)

    await mkdir(path.join(root, ".ues-cache"), { recursive: true })
    await mkdir(path.join(root, ".ues-traces"), { recursive: true })
    await mkdir(path.join(root, ".ues-work", "demo"), { recursive: true })
    await writeFile(path.join(root, ".ues-cache", "state.json"), "{}\n")
    await writeFile(path.join(root, ".ues-traces", "trace.jsonl"), "{}\n")
    await writeFile(path.join(root, ".ues-work", "demo", "STATE.json"), "{}\n")

    const afterInternalState = runtimeWorkspaceFingerprint(root)
    assert.equal(afterInternalState, before)

    await writeFile(path.join(root, "source.txt"), "two\n")
    const afterSourceChange = runtimeWorkspaceFingerprint(root)
    assert.notEqual(afterSourceChange, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("process supervisor reports user abort with shell-style exit code 130", async () => {
  const controller = new AbortController()
  const promise = runSupervisedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
    hardTimeoutMs: 5000,
    drainTimeoutMs: 200,
    killGraceMs: 50,
  })
  setTimeout(() => controller.abort(), 50)
  const result = await promise
  assert.equal(result.stopReason, "aborted")
  assert.equal(result.exitCode, 130)
})

test("verification receipt eligibility rejects masked shell exits", () => {
  assert.equal(looksLikeVerificationCommand("pnpm test"), true)
  assert.equal(canRecordReusableVerification("pnpm test"), true)
  assert.equal(canRecordReusableVerification("pnpm test && npm run typecheck"), true)

  assert.equal(hasMaskedShellExitRisk("pnpm test || true"), true)
  assert.equal(canRecordReusableVerification("pnpm test || true"), false)
  assert.equal(canRecordReusableVerification("pnpm test ; echo done"), false)
  assert.equal(canRecordReusableVerification("pnpm test | tee test.log"), false)
  assert.equal(canRecordReusableVerification("pnpm test\necho done"), false)
  assert.equal(canRecordReusableVerification("pnpm test & echo background"), false)
})

test("simple verification commands canonicalize to executable plus args", () => {
  assert.deepEqual(
    canonicalVerificationCommand("pnpm --filter @agrimarket/api test -- refund.spec.ts"),
    {
      command: "pnpm",
      args: ["--filter", "@agrimarket/api", "test", "--", "refund.spec.ts"],
      raw: "pnpm --filter @agrimarket/api test -- refund.spec.ts",
    },
  )
  assert.deepEqual(
    canonicalVerificationCommand('npm test -- "test/payment refund.spec.ts"'),
    {
      command: "npm",
      args: ["test", "--", "test/payment refund.spec.ts"],
      raw: 'npm test -- "test/payment refund.spec.ts"',
    },
  )
  assert.equal(canonicalVerificationCommand("pnpm test && npm run typecheck"), null)
  assert.equal(canonicalVerificationCommand("pnpm test || true"), null)
  assert.equal(canonicalVerificationCommand("pnpm test | tee test.log"), null)
  assert.equal(canonicalVerificationCommand("powershell -Command pnpm test"), null)
  assert.equal(canonicalVerificationCommand("NODE_ENV=test npm test"), null)
  assert.equal(canonicalVerificationCommand('cmd /c "pnpm test"'), null)
})

test("workspace snapshot shares fingerprint and changed-file evidence", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "tracked.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    await writeFile(path.join(root, "tracked.txt"), "two\n")

    const snapshot = runtimeWorkspaceSnapshot(root)
    assert.equal(snapshot.git, true)
    assert.equal(snapshot.cacheable, true)
    assert.ok(snapshot.changedFiles.includes("tracked.txt"))
    assert.equal(snapshot.fingerprint, runtimeWorkspaceFingerprint(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("affected-test cache reuses only an identical workspace snapshot", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))
    await writeFile(path.join(root, "src", "thing.ts"), "export const thing = 1\n")
    await writeFile(path.join(root, "test", "thing.spec.ts"), "import { thing } from '../src/thing'\ntest('thing',()=>thing)\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    await writeFile(path.join(root, "src", "thing.ts"), "export const thing = 2\n")
    const snapshot = runtimeWorkspaceSnapshot(root)

    const first = await resolveAffectedTests(root, {
      limit: 5,
      changedFiles: snapshot.changedFiles,
      workspaceFingerprint: snapshot.fingerprint,
    })
    const second = await resolveAffectedTests(root, {
      limit: 5,
      changedFiles: snapshot.changedFiles,
      workspaceFingerprint: snapshot.fingerprint,
    })
    assert.equal(first.cacheHit, false)
    assert.equal(second.cacheHit, true)
    assert.equal(second.tests[0]?.path, "test/thing.spec.ts")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("micro-skill compiler reuses bounded compiled excerpts", async () => {
  const policy = { maxSkills: 2, domains: ["payment"] }
  const first = await compileSkillContext(policy, "executor", { totalChars: 1600 })
  const second = await compileSkillContext(policy, "executor", { totalChars: 1600 })
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(second.text, first.text)
})

test("verification broker rejects a PASS receipt when the check changed workspace state", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const before = runtimeWorkspaceFingerprint(root)

    await writeFile(path.join(root, "a.txt"), "two\n")
    const after = runtimeWorkspaceFingerprint(root)
    assert.notEqual(after, before)

    await recordVerification(root, {
      command: "shell",
      args: ["pnpm test"],
      exitCode: 0,
      stdout: "Tests: 1 passed, 1 total",
      stderr: "",
      workspaceBefore: before,
      workspaceAfter: after,
      durationMs: 1,
    })

    const reused = await findReusableVerification(root, "shell", ["pnpm test"])
    assert.equal(reused, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic runtime cache reuses an unchanged workspace snapshot", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "demo.ts"), "export const demo = 1\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])

    clearSemanticIndexRuntimeCache()
    const snapshot = runtimeWorkspaceSnapshot(root)
    const first = await buildSemanticIndexCached(root, {
      workspaceFingerprint: snapshot.fingerprint,
      maxFiles: 100,
    })
    const second = await buildSemanticIndexCached(root, {
      workspaceFingerprint: snapshot.fingerprint,
      maxFiles: 100,
    })
    assert.equal(first.runtimeCacheHit, false)
    assert.equal(second.runtimeCacheHit, true)

    await writeFile(path.join(root, "src", "demo.ts"), "export const demo = 2\n")
    const changed = runtimeWorkspaceSnapshot(root)
    const third = await buildSemanticIndexCached(root, {
      workspaceFingerprint: changed.fingerprint,
      maxFiles: 100,
    })
    assert.equal(third.runtimeCacheHit, false)
  } finally {
    clearSemanticIndexRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic index includes legitimate bin source while graph skips UES sandboxes", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "bin"), { recursive: true })
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, ".ues-sandboxes", "copy", "src"), { recursive: true })
    await writeFile(path.join(root, "bin", "cli.mjs"), "export function cliEntry() { return 1 }\n")
    await writeFile(path.join(root, "src", "app.mjs"), "import { cliEntry } from '../bin/cli.mjs'\nexport const app = cliEntry()\n")
    await writeFile(path.join(root, ".ues-sandboxes", "copy", "src", "ghost.mjs"), "export const ghost = 1\n")
    git(root, ["add", "bin", "src"])
    git(root, ["commit", "-m", "base"])

    clearSemanticIndexRuntimeCache()
    const snapshot = runtimeWorkspaceSnapshot(root)
    const semantic = await buildSemanticIndexCached(root, {
      workspaceFingerprint: snapshot.fingerprint,
      maxFiles: 100,
    })
    assert.ok(Object.hasOwn(semantic.index.files, "bin/cli.mjs"))

    const graph = await buildRepoGraph(root, { maxFiles: 100 })
    assert.ok(graph.nodes.some((node) => node.path === "bin/cli.mjs"))
    assert.equal(
      graph.nodes.some((node) => node.path.includes(".ues-sandboxes")),
      false,
    )
  } finally {
    clearSemanticIndexRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("runtime fingerprint changes when untracked file content changes", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])

    await writeFile(path.join(root, "draft.ts"), "export const value = 'one'\n")
    const first = runtimeWorkspaceSnapshot(root)
    assert.equal(first.cacheable, true)
    assert.ok(first.changedFiles.includes("draft.ts"))

    await writeFile(path.join(root, "draft.ts"), "export const value = 'two'\n")
    const second = runtimeWorkspaceSnapshot(root)
    assert.equal(second.cacheable, true)
    assert.notEqual(second.fingerprint, first.fingerprint)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test("RPC pool labels pre-prompt worker failure as startup", async () => {
  const pool = new PiRpcWorkerPool({ maxWorkers: 1 })
  try {
    let error = null
    try {
      await pool.run(
        "startup-failure",
        {
          command: process.execPath,
          args: ["-e", "process.exit(2)"],
          cwd: process.cwd(),
          env: process.env,
        },
        "never-dispatched",
      )
    } catch (caught) {
      error = caught
    }
    assert.ok(error)
    assert.equal(error.uesRpcPhase, "startup")
  } finally {
    await pool.stopAll()
  }
})

test("external RPC abort rejects the active run instead of settling normally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-rpc-abort-"))
  const script = path.join(root, "fake-rpc.mjs")
  const source = [
    "import readline from 'node:readline'",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line)",
    "  if (msg.type === 'get_state' || msg.type === 'prompt' || msg.type === 'abort') {",
    "    process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true }) + '\\n')",
    "  }",
    "})",
  ].join("\n")
  await writeFile(script, source)

  const pool = new PiRpcWorkerPool({ maxWorkers: 1 })
  try {
    const outcome = pool.run(
      "runtime-abort",
      {
        command: process.execPath,
        args: [script],
        cwd: root,
        env: process.env,
      },
      "stay active until aborted",
      { hardTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )

    assert.equal(await waitFor(() => pool.status().activeWorkers === 1), true)
    const aborted = await pool.abortActive()
    assert.equal(aborted.aborted, 1)

    const result = await outcome
    assert.ok(result.error)
    assert.equal(result.error.uesRpcPhase, "runtime")
    assert.match(String(result.error.message || result.error), /UES RPC aborted/i)
  } finally {
    await pool.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})

test("verification broker preserves concurrent receipts in one workspace", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const fp = runtimeWorkspaceFingerprint(root)

    await Promise.all([
      recordVerification(root, {
        command: "node",
        args: ["--version"],
        exitCode: 0,
        stdout: "v1",
        stderr: "",
        workspaceBefore: fp,
        workspaceAfter: fp,
        durationMs: 1,
      }),
      recordVerification(root, {
        command: "npm",
        args: ["test"],
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        workspaceBefore: fp,
        workspaceAfter: fp,
        durationMs: 1,
      }),
    ])

    assert.ok(await findReusableVerification(root, "node", ["--version"]))
    assert.ok(await findReusableVerification(root, "npm", ["test"]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic runtime cache coalesces concurrent builds for one fingerprint", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        path.join(root, "src", "f" + index + ".ts"),
        "export const value" + index + " = " + index + "\n",
      )
    }
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    clearSemanticIndexRuntimeCache()
    const snapshot = runtimeWorkspaceSnapshot(root)

    const [first, second] = await Promise.all([
      buildSemanticIndexCached(root, { workspaceFingerprint: snapshot.fingerprint, maxFiles: 200 }),
      buildSemanticIndexCached(root, { workspaceFingerprint: snapshot.fingerprint, maxFiles: 200 }),
    ])
    assert.equal(first.index.files["src/f0.ts"] != null, true)
    assert.equal(second.index.files["src/f0.ts"] != null, true)
    assert.equal(
      first.runtimeCacheCoalesced === true || second.runtimeCacheCoalesced === true,
      true,
    )
  } finally {
    clearSemanticIndexRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("affected-test resolver coalesces concurrent identical scans", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))
    await writeFile(path.join(root, "src", "thing.ts"), "export const thing = 1\n")
    await writeFile(path.join(root, "test", "thing.spec.ts"), "import { thing } from '../src/thing'\ntest('thing',()=>thing)\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    await writeFile(path.join(root, "src", "thing.ts"), "export const thing = 2\n")
    clearAffectedTestCache()
    const snapshot = runtimeWorkspaceSnapshot(root)
    const options = {
      limit: 5,
      changedFiles: snapshot.changedFiles,
      workspaceFingerprint: snapshot.fingerprint,
    }

    const [first, second] = await Promise.all([
      resolveAffectedTests(root, options),
      resolveAffectedTests(root, options),
    ])
    assert.equal(first.tests[0]?.path, "test/thing.spec.ts")
    assert.equal(second.tests[0]?.path, "test/thing.spec.ts")
    assert.equal(first.cacheCoalesced === true || second.cacheCoalesced === true, true)
  } finally {
    clearAffectedTestCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("verification broker rejects malformed receipts and waits for an external cache lock", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const fp = runtimeWorkspaceFingerprint(root)
    const lockDir = path.join(root, ".ues-cache", "verification-broker-v1.json.lock")
    await mkdir(lockDir, { recursive: true })
    setTimeout(() => {
      void rm(lockDir, { recursive: true, force: true })
    }, 120)

    const started = Date.now()
    await recordVerification(root, {
      command: "node",
      args: ["--version"],
      exitCode: 0,
      stdout: "v1",
      stderr: "",
      workspaceBefore: fp,
      workspaceAfter: fp,
      durationMs: 1,
    })
    assert.ok(Date.now() - started >= 80)

    const cacheFile = path.join(root, ".ues-cache", "verification-broker-v1.json")
    const cache = JSON.parse(await readFile(cacheFile, "utf8"))
    const entry = Object.values(cache.entries)[0]
    entry.finishedAt = "not-a-date"
    await writeFile(cacheFile, JSON.stringify(cache, null, 2) + "\n")

    assert.equal(
      await findReusableVerification(root, "node", ["--version"], { maxAgeMs: 60_000 }),
      null,
    )
    let listed = await listReusableVerification(root, { maxAgeMs: 60_000 })
    assert.equal(listed.count, 0)

    entry.finishedAt = entry.receipt.finishedAt
    entry.receipt.exitCode = 1
    entry.receipt.passed = true
    await writeFile(cacheFile, JSON.stringify(cache, null, 2) + "\n")
    assert.equal(
      await findReusableVerification(root, "node", ["--version"], { maxAgeMs: 60_000 }),
      null,
    )
    listed = await listReusableVerification(root, { maxAgeMs: 60_000 })
    assert.equal(listed.count, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("RPC pool never evicts an active worker when an idle-capacity limit is exceeded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-rpc-lru-"))
  const script = path.join(root, "fake-rpc.mjs")
  const source = [
    "import readline from 'node:readline'",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line)",
    "  if (msg.type === 'get_state' || msg.type === 'new_session' || msg.type === 'abort') {",
    "    process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true }) + '\\n')",
    "    return",
    "  }",
    "  if (msg.type === 'prompt') {",
    "    process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true }) + '\\n')",
    "    if (String(msg.message).includes('finish')) {",
    "      process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\\n')",
    "      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')",
    "    }",
    "  }",
    "})",
  ].join("\n")
  await writeFile(script, source)

  const pool = new PiRpcWorkerPool({ maxWorkers: 1 })
  try {
    const spec = {
      command: process.execPath,
      args: [script],
      cwd: root,
      env: process.env,
    }
    const held = pool.run(
      "held",
      spec,
      "hold",
      { hardTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    assert.equal(await waitFor(() => pool.status().activeWorkers === 1), true)

    const second = await pool.run(
      "second",
      spec,
      "finish",
      { hardTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
    )
    assert.equal(second.message?.role, "assistant")
    const status = pool.status()
    assert.equal(status.activeWorkers, 1)
    assert.equal(status.active[0]?.key, "held")

    const aborted = await pool.abortActive()
    assert.equal(aborted.aborted, 1)
    const heldResult = await held
    assert.ok(heldResult.error)
    assert.match(String(heldResult.error.message || heldResult.error), /UES RPC aborted/i)
  } finally {
    await pool.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})
