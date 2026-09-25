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
