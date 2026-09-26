import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { anchoredLines, applyAnchoredEdits } from "../lib/code-intelligence/edit-anchor.mjs"
import { applyAnchoredFileEdits, readAnchoredCode } from "../lib/code-intelligence/index.mjs"
import { auditCompletion } from "../lib/completion-auditor.mjs"
import { ingestDocument } from "../lib/document-ingestion.mjs"
import { compactContext, expandContext, searchContext } from "../lib/reversible-context.mjs"
import { mcpExecutionPolicy } from "../lib/mcp-tool-policy.mjs"
import { buildPromptEnvelope, comparePromptEnvelopes } from "../lib/prompt-cache.mjs"
import { buildMemorySnapshot } from "../lib/memory-engine.mjs"

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "ues-v143-"))
}

test("hash anchored edits fail closed when the anchor is stale", () => {
  const first = anchoredLines("one\ntwo\nthree")
  const anchor = first.rows[1].anchor
  assert.equal(applyAnchoredEdits("one\ntwo\nthree", [{ anchor, replacement: "TWO" }]).text, "one\nTWO\nthree")
  assert.throws(
    () => applyAnchoredEdits("one\nchanged\nthree", [{ anchor, replacement: "TWO" }]),
    (error) => error?.code === "UES_STALE_ANCHOR",
  )
})

test("anchored file editing preserves workspace containment and applies exact lines", async () => {
  const root = await tempDir()
  try {
    await writeFile(path.join(root, "demo.js"), "export const one = 1\nexport const two = 2\n")
    const read = await readAnchoredCode(root, "demo.js")
    const anchor = read.rows[1].anchor
    const result = await applyAnchoredFileEdits(root, "demo.js", [{ anchor, replacement: "export const two = 22" }])
    assert.equal(result.applied, 1)
    assert.match(await readFile(path.join(root, "demo.js"), "utf8"), /two = 22/)
    await assert.rejects(() => readAnchoredCode(root, "../escape.js"), /escapes workspace root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completion auditor rejects narrative PASS without structured proof", () => {
  const rejected = auditCompletion({
    verification: { exitCode: 0, verdict: "PASS", output: "UES_VERDICT: PASS", report: { valid: true, verdict: "PASS", sections: {} } },
  })
  assert.equal(rejected.passed, false)
  assert.ok(rejected.failures.includes("missing-report-section:checks-run"))

  const accepted = auditCompletion({
    verification: {
      exitCode: 0,
      verdict: "PASS",
      output: "UES_VERDICT: PASS",
      report: {
        valid: true,
        verdict: "PASS",
        sections: {
          "checks-run": "node --test: exit 0",
          "acceptance-criteria-proven": "All explicit branches proven by tests.",
          "completion-evidence": "Fresh executable evidence passed.",
          failures: "None.",
          "unresolved-gaps": "None.",
        },
      },
    },
    workspaceSnapshot: { cacheable: true, fingerprint: "abc", changedFiles: ["demo.js"] },
  })
  assert.equal(accepted.passed, true)
})

test("document ingestion is dependency-free for text and bounded to workspace", async () => {
  const root = await tempDir()
  try {
    await writeFile(path.join(root, "note.md"), "# Hello\nWorld\n")
    const result = await ingestDocument(root, "note.md")
    assert.equal(result.provider, "builtin-text")
    assert.match(result.markdown, /Hello/)
    await assert.rejects(() => ingestDocument(root, "../outside.md"), /escapes workspace root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reversible context keeps raw evidence searchable and expandable", async () => {
  const root = await tempDir()
  try {
    const raw = "# Summary\nimportant payment failure\n" + "noise\n".repeat(100)
    const compacted = await compactContext(root, raw, { t1Chars: 128 })
    assert.match(compacted.ref, /^evidence:sha256:/)
    assert.ok(compacted.levels.T1.length < raw.length)
    const searched = await searchContext(root, compacted.ref, "payment failure")
    assert.equal(searched.hits.length > 0, true)
    const expanded = await expandContext(root, compacted.ref, { maxBytes: 4096 })
    assert.match(expanded.content, /important payment failure/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("prompt cache telemetry separates stable snapshots from dynamic task state", () => {
  const a = buildPromptEnvelope({ role: "executor", memorySnapshot: { generation: 3, ids: ["m1"] }, task: { id: "a" } })
  const b = buildPromptEnvelope({ role: "executor", memorySnapshot: { generation: 3, ids: ["m1"] }, task: { id: "b" } })
  const reuse = comparePromptEnvelopes(a, b, { cacheReadTokens: 123, cacheWriteTokens: 4 })
  assert.equal(reuse.stableReused, true)
  assert.equal(reuse.cacheReadTokens, 123)
  assert.equal(reuse.prefixMutationReason, null)

  const c = buildPromptEnvelope({ role: "executor", memorySnapshot: { generation: 4, ids: ["m1", "m2"] }, task: { id: "b" } })
  const changed = comparePromptEnvelopes(b, c)
  assert.equal(changed.stableReused, false)
  assert.match(changed.prefixMutationReason, /memorySnapshot/)
})

test("verified memory snapshots ignore retrieval/touch noise but change with durable memory content", () => {
  const base = [{
    id: "m1",
    type: "semantic",
    scope: "project",
    content: "Use the project-native verifier.",
    confidence: 0.9,
    files: ["src/a.ts"],
    verifiedAt: "2026-09-26T00:00:00.000Z",
    lastUsedAt: "2026-09-26T01:00:00.000Z",
    useCount: 1,
    retrieval: { score: 0.2 },
  }]
  const touched = [{ ...base[0], lastUsedAt: "2026-09-26T02:00:00.000Z", useCount: 99, retrieval: { score: 0.9 } }]
  assert.equal(buildMemorySnapshot(base).generation, buildMemorySnapshot(touched).generation)

  const changed = [{ ...base[0], content: "Use a different durable rule." }]
  assert.notEqual(buildMemorySnapshot(base).generation, buildMemorySnapshot(changed).generation)
})

test("MCP annotations only tighten execution policy", () => {
  const destructive = mcpExecutionPolicy({ name: "delete_remote", annotations: { destructiveHint: true, idempotentHint: true } })
  assert.equal(destructive.confirmationRequired, true)
  assert.equal(destructive.retryAllowed, false)

  const read = mcpExecutionPolicy({ name: "search_remote", annotations: { readOnlyHint: true, openWorldHint: true } })
  assert.equal(read.fastAllowed, true)
  assert.equal(read.externalEvidenceBoundary, true)
  assert.equal(read.trust, "hint-only")
})
