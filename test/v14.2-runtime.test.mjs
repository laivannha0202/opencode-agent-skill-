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