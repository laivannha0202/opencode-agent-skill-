// V16.7.1 workspace-root call-site regression.
//
// DEFECT (pre-existing at HEAD): `resolveGitWorkspaceRoot(start)` returns
// `{ ok, requested, root, error }`, NOT a string. Three production call sites in
// the shipped extension treated the return value as a string/boolean:
//
//   1. `session_before_compact` -> `checkpointDurableWorkBeforeCompaction(root)`
//   2. `session_compact`        -> `buildCompactionResumeGuard(root)`
//   3. `input` auto-admission   -> `workspaceRoot ? ... : ...`
//
// (1) and (2) passed the OBJECT where a path string is required, so the helper
// threw `The "paths[0]" argument must be of type string`, and every caller
// swallowed the throw with `.catch(() => null)` / `.catch(() => [])`. The
// durable compaction resume guard therefore NEVER ran in production.
//
// (3) tested the raw object for truthiness, which is ALWAYS true, so the V15.12
// "fail closed outside a Git workspace" admission check was defeated: a
// non-Git directory was admitted as if it were a worktree.
//
// These tests pin the fix at the seam that actually broke.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  buildCompactionResumeGuard,
  checkpointDurableWorkBeforeCompaction,
} from "../lib/compaction-resume-guard.mjs"
import { resolveGitWorkspaceRoot } from "../lib/workspace-root.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

// ---------------------------------------------------------------------------
// 1. The resolver contract that every call site must honour.
// ---------------------------------------------------------------------------
test("V16.7.1 workspace root: resolveGitWorkspaceRoot returns { ok, root }, never a string", () => {
  const inside = resolveGitWorkspaceRoot(ROOT)
  assert.equal(typeof inside, "object")
  assert.equal(inside.ok, true)
  assert.equal(typeof inside.root, "string")
  assert.ok(inside.root.length > 0)

  const base = mkdtempSync(path.join(os.tmpdir(), "ues-root-contract-"))
  try {
    const outside = resolveGitWorkspaceRoot(base)
    assert.equal(typeof outside, "object")
    assert.equal(outside.ok, false)
    assert.equal(outside.root, null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The compaction helpers REQUIRE a string root and THROW on the object.
//    This is exactly why the swallowed production call never worked.
// ---------------------------------------------------------------------------
test("V16.7.1 workspace root: the compaction helpers reject the raw object root", async () => {
  const object = resolveGitWorkspaceRoot(ROOT)
  await assert.rejects(
    () => checkpointDurableWorkBeforeCompaction(object, { reason: "test", maxWorkspaces: 1 }),
    /argument must be of type string/,
  )
  await assert.rejects(
    () => buildCompactionResumeGuard(object, { reason: "test", maxWorkspaces: 1 }),
    /argument must be of type string/,
  )
})

test("V16.7.1 workspace root: the compaction helpers accept the .root string", async () => {
  const root = resolveGitWorkspaceRoot(ROOT).root
  const checkpoints = await checkpointDurableWorkBeforeCompaction(root, { reason: "test", maxWorkspaces: 1 })
  assert.ok(Array.isArray(checkpoints), "checkpointing must return an array, not throw")
  const packet = await buildCompactionResumeGuard(root, { reason: "test", maxWorkspaces: 1 })
  assert.equal(packet.kind, "ues-durable-compaction-resume-guard")
})

// ---------------------------------------------------------------------------
// 3. The V15.12 fail-closed admission check is only reachable with `.root`.
// ---------------------------------------------------------------------------
test("V16.7.1 workspace root: a non-Git directory must not look like a worktree", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-root-admit-"))
  try {
    const object = resolveGitWorkspaceRoot(base)
    // The RAW object is always truthy -> this is the defect.
    assert.equal(Boolean(object), true)
    // `.root` is null outside a worktree -> this is the fix.
    assert.equal(Boolean(object.root), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  // A real worktree resolves to a non-empty string.
  const repo = mkdtempSync(path.join(os.tmpdir(), "ues-root-repo-"))
  try {
    const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr || init.stdout)
    assert.equal(Boolean(resolveGitWorkspaceRoot(repo).root), true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Source contract: the shipped extension uses `.root` at every call site.
// ---------------------------------------------------------------------------
test("V16.7.1 workspace root source: the extension never passes the raw object root", () => {
  const source = readFileSync(EXTENSION, "utf8")
  // Every resolver call site must read `.root` (optionally via optional
  // chaining) OR be inside the resolver module itself. Scan line-by-line so a
  // nested `(ctx as any)` cannot defeat the check.
  const offenders = source
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.includes("resolveGitWorkspaceRoot("))
    .filter(({ line }) => !/\)\s*\?\.?\s*root/.test(line))
  assert.deepEqual(
    offenders,
    [],
    `raw resolver uses must read .root: ${offenders.map((o) => `${o.number}:${o.line}`).join(" | ")}`,
  )
  // The three production seams are explicitly fixed.
  assert.ok(
    source.includes("checkpointDurableWorkBeforeCompaction(root, {"),
    "session_before_compact must pass a string root to the checkpoint helper",
  )
  assert.ok(
    source.includes("buildCompactionResumeGuard(root, {"),
    "session_compact must pass a string root to the resume guard",
  )
  const admissionBlock = source.slice(
    source.indexOf("const preliminaryAdmission = automaticUesAdmission(text)"),
    source.indexOf("const admission = workspaceRoot"),
  )
  assert.ok(admissionBlock.includes('resolveGitWorkspaceRoot(ctx.cwd || "")?.root'), "auto-admission must test `.root`")
})
