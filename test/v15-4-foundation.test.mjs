import assert from "node:assert/strict"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildTaskTelemetry, readTaskTelemetry, recordTaskTelemetry, summarizeTaskTelemetryRows } from "../lib/run-telemetry.mjs"
import { recordCompaction, recordCompactionRecall, summarizeCompactionRecall } from "../lib/compaction-recall.mjs"
import { evaluatePermissionRules, preflightToolExposure, toolPermissionRequest } from "../lib/permission-policy.mjs"
import { detectMutationShape } from "../lib/mutation-shape.mjs"
import { ingestDocument } from "../lib/document-ingestion.mjs"

test("V15.4 task telemetry stores operational metrics without raw task text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v154-telemetry-"))
  try {
    const receipt = buildTaskTelemetry({ agent:"ues-verifier", task:"fix checkout", exitCode:0, verdict:"PASS", durationMs:120, toolCalls:3, toolNames:["read","bash","read"], providerRecoveryAttempts:1, optimizations:{ latencyMs:{ workspaceSnapshot:5, contextBuild:10, modelRun:80, hygiene:5, total:110 } } })
    assert.equal(receipt.metrics.totalTokens, null)
    assert.equal(receipt.metrics.timingConsistent, true)
    assert.deepEqual(receipt.metrics.toolNames, ["read","bash"])
    assert.equal(receipt.outcome.passed, true)
    await recordTaskTelemetry(root, { agent:"ues-verifier", task:"fix checkout", exitCode:0, verdict:"PASS", durationMs:120, toolCalls:3, usage:{ inputTokens:100, outputTokens:40 } })
    const rows = await readTaskTelemetry(root)
    assert.equal(rows.length, 1)
    const summary = summarizeTaskTelemetryRows(rows)
    assert.equal(summary.runs, 1)
    assert.equal(summary.averageTotalTokens, 140)
    assert.equal(summary.byScope["specialist-run"].runs, 1)
    const raw = await readFile(path.join(root, ".ues-learning", "task-telemetry-v1.jsonl"), "utf8")
    assert.doesNotMatch(raw, /fix checkout/)
  } finally { await rm(root, { recursive:true, force:true }) }
})

test("V15.4 compaction recall attributes repeated recovery to the original ref", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v154-recall-"))
  try {
    await recordCompaction(root, { ref:"evidence:sha256:"+"a".repeat(64), reducer:"npm-test", rawChars:10000, returnedChars:1000 })
    await recordCompaction(root, { ref:"evidence:sha256:"+"b".repeat(64), reducer:"git-diff", rawChars:5000, returnedChars:1500 })
    await recordCompactionRecall(root, { ref:"evidence:sha256:"+"a".repeat(64), kind:"expand", returnedBytes:1200 })
    await recordCompactionRecall(root, { ref:"evidence:sha256:"+"a".repeat(64), kind:"search", returnedBytes:300, query:"failing assertion" })
    const summary = await summarizeCompactionRecall(root)
    assert.equal(summary.compactedRefs, 2)
    assert.equal(summary.recalledRefs, 1)
    assert.equal(summary.recallDemandRate, 0.5)
    assert.equal(summary.totalRecallEvents, 2)
  } finally { await rm(root, { recursive:true, force:true }) }
})

test("V15.4 preflight hides only deterministic action-wide deny", () => {
  const rules = [{ action:"edit", resource:"*", effect:"deny" }, { action:"shell", resource:"git push *", effect:"deny" }]
  const plan = preflightToolExposure(rules, ["read","edit","bash"], { defaultEffect:"allow", platform:"linux" })
  assert.deepEqual(plan.tools, ["read","bash"])
  assert.deepEqual(plan.hidden.map((row) => row.tool), ["edit"])
  const resourceSpecific = preflightToolExposure([{ action:"edit", resource:"*", effect:"deny" }, { action:"edit", resource:"src/*.ts", effect:"allow" }], ["edit"], { defaultEffect:"allow" })
  assert.deepEqual(resourceSpecific.tools, ["edit"])
  assert.equal(evaluatePermissionRules(rules, { action:"shell", resource:"git push origin main" }).effect, "deny")
  assert.deepEqual(toolPermissionRequest("str_replace", { path:"src/a.ts", replacement:"x" }), { action:"edit", resources:["src/a.ts"] })
  assert.deepEqual(toolPermissionRequest("custom_mutator", { path:"src/a.ts", replacement:"x" }), { action:"edit", resources:["src/a.ts"] })
})

test("V15.4 mutation-shape detects custom writers but not known reads", () => {
  assert.equal(detectMutationShape("read", { path:"src/a.ts", content:"not a write" }).mutation, "no")
  const custom = detectMutationShape("custom_replace", { path:"src/a.ts", replacement:"const x = 1" })
  assert.equal(custom.mutation, "yes")
  assert.deepEqual(custom.files, ["src/a.ts"])
  const multi = detectMutationShape("custom_patch", { operations:[{ op:"update", path:"src/a.ts" },{ op:"delete", path:"src/b.ts" }] })
  assert.equal(multi.mutation, "yes")
  assert.deepEqual(multi.files, ["src/a.ts","src/b.ts"])
})

test("V15.4 MarkItDown path is async and reuses identical content after rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v154-doc-"))
  let calls = 0
  const runner = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { provider:"fake-markitdown", markdown:"# converted\n", durationMs:5 } }
  try {
    await writeFile(path.join(root, "a.pdf"), Buffer.from("PDF-A"))
    const first = await ingestDocument(root, "a.pdf", { markitdownRunner:runner })
    assert.equal(first.schemaVersion, 1)
    assert.equal(first.cacheHit, false); assert.equal(calls, 1)
    await rename(path.join(root, "a.pdf"), path.join(root, "renamed.pdf"))
    const renamed = await ingestDocument(root, "renamed.pdf", { markitdownRunner:runner })
    assert.equal(renamed.cacheHit, true); assert.equal(calls, 1); assert.equal(renamed.contentSha256, first.contentSha256)
    await writeFile(path.join(root, "renamed.pdf"), Buffer.from("PDF-B"))
    const changed = await ingestDocument(root, "renamed.pdf", { markitdownRunner:runner })
    assert.equal(changed.cacheHit, false); assert.equal(calls, 2); assert.notEqual(changed.contentSha256, first.contentSha256)

    await writeFile(path.join(root, "same.pdf"), Buffer.from("PDF-C"))
    let release
    const wait = new Promise((resolve) => { release = resolve })
    let coalescedCalls = 0
    const coalescedRunner = async () => { coalescedCalls += 1; await wait; return { provider:"fake-markitdown", markdown:"# shared\n", durationMs:5 } }
    const p1 = ingestDocument(root, "same.pdf", { markitdownRunner:coalescedRunner, converterIdentity:"coalesce-test" })
    const p2 = ingestDocument(root, "same.pdf", { markitdownRunner:coalescedRunner, converterIdentity:"coalesce-test" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(coalescedCalls, 1)
    release()
    await Promise.all([p1, p2])

    await writeFile(path.join(root, "abort.pdf"), Buffer.from("PDF-D"))
    const abort = new AbortController()
    let sawAbort = false
    const abortRunner = async (_file, options) => await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        sawAbort = true
        const error = new Error("aborted")
        error.code = "ABORT_ERR"
        reject(error)
      }, { once:true })
    })
    const aborted = ingestDocument(root, "abort.pdf", { markitdownRunner:abortRunner, converterIdentity:"abort-test", signal:abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    abort.abort()
    await assert.rejects(aborted, /aborted/)
    assert.equal(sawAbort, true)
  } finally { await rm(root, { recursive:true, force:true }) }
})
