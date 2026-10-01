import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function source(relative) {
  return readFile(path.join(root, ...relative.split("/")), "utf8")
}

test("V16 parent FAST lanes are wired to static completeness evidence", async () => {
  const text = await source("pi/extensions/ues.ts")
  assert.match(text, /collectFastStaticEvidence/)
  assert.ok(
    (text.match(/staticEvidence,/g) || []).length >= 2,
    "both structured-leaf and direct FAST lanes must pass static evidence to the gate",
  )
  assert.match(text, /staticEvidence:\s*leafFastGate\.staticEvidence/)
  assert.match(text, /staticEvidence:\s*fastGate\.staticEvidence/)
})

test("V16 external outputs keep an explicit non-authoritative provenance boundary", async () => {
  const [runtime, boundary] = await Promise.all([
    source("pi/extensions/ues-child-runtime.ts"),
    source("lib/untrusted-output.mjs"),
  ])
  assert.match(runtime, /trustClass:\s*"external-data"/)
  assert.match(runtime, /always:\s*true/)
  assert.match(boundary, /instructionAuthority:\s*"none"/)
  assert.match(boundary, /UES EXTERNAL DATA BOUNDARY/)
})

test("V16 durable evidence GC and resume integrity remain wired", async () => {
  const [store, resume, task] = await Promise.all([
    source("lib/evidence-store.mjs"),
    source("lib/compaction-resume-guard.mjs"),
    source("lib/task-engine.mjs"),
  ])
  assert.match(store, /protectedActiveWorkEvidenceHashes/)
  assert.match(store, /protectActiveWorkRefs/)
  assert.match(resume, /evidenceIntegrity/)
  assert.match(resume, /DEGRADED/)
  assert.match(task, /evidenceRefsIn/)
})

test("V16 cleanup call sites use the bounded filesystem primitive", async () => {
  const [worktree, hygiene] = await Promise.all([
    source("lib/worktree-sandbox.mjs"),
    source("lib/workspace-hygiene.mjs"),
  ])
  assert.match(worktree, /safeRemovePath/)
  assert.match(hygiene, /safeRemovePath/)
})
