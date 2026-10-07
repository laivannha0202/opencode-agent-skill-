// V16.9 module tests: workspace-state-owner + prewrite-fence.
//
// These two modules are the correctness-critical foundation: they answer "is the
// workspace still the one the advisor saw?" and "may the executor write?". Both
// must FAIL CLOSED, so the tests assert the failure modes explicitly.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  WORKSPACE_STATE_OWNER_POLICY,
  captureOwnedWorkspaceState,
  createWorkspaceStateOwner,
  diffOwnedWorkspaceState,
} from "../lib/workspace-state-owner.mjs"
import {
  PREWRITE_FENCE_POLICY,
  PREWRITE_FENCE_REASON,
  createPrewriteFence,
  evaluatePrewriteFence,
} from "../lib/prewrite-fence.mjs"

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-wso-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  writeFileSync(path.join(root, "src.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

test("workspace-state-owner: capture is generation-tagged and available", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const first = owner.capture("pre")
    assert.equal(first.available, true)
    assert.equal(first.generation, 1)
    assert.ok(first.fingerprint)
    const second = owner.capture("post")
    assert.equal(second.generation, 2)
    assert.notEqual(first.generation, second.generation)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace-state-owner: same-generation comparison is not comparable", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const snapshot = owner.capture("only")
    const diff = owner.mutationBetween(snapshot, snapshot)
    assert.equal(diff.comparable, false)
    assert.equal(diff.mutated, null)
    assert.equal(diff.reason, "same-generation")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace-state-owner: mutation is detected with changed paths", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const before = owner.capture("before")
    writeFileSync(path.join(root, "src.mjs"), "export const value = 2\n")
    const after = owner.capture("after")
    const diff = owner.mutationBetween(before, after)
    assert.equal(diff.comparable, true)
    assert.equal(diff.mutated, true)
    assert.ok(diff.addedPaths.includes("src.mjs") || diff.removedPaths.includes("src.mjs"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace-state-owner: unavailable snapshot fails closed", () => {
  const state = captureOwnedWorkspaceState(null)
  assert.equal(state.available, false)
  assert.equal(state.fingerprint, null)
  assert.ok(state.reason)
  const diff = diffOwnedWorkspaceState({ available: false }, { available: true, fingerprint: "x" })
  assert.equal(diff.comparable, false)
  assert.equal(diff.mutated, null)
})

test("prewrite-fence: allows a write when the workspace is unchanged", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const fence = createPrewriteFence({ owner })
    fence.armBefore()
    const result = fence.check({ writeTargets: ["src.mjs"] })
    assert.equal(result.allowed, true)
    assert.equal(result.status, "allowed")
    assert.deepEqual(result.reasons, [])
    assert.equal(result.policy, PREWRITE_FENCE_POLICY)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prewrite-fence: denies a write when the workspace mutated", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const fence = createPrewriteFence({ owner })
    fence.armBefore()
    writeFileSync(path.join(root, "src.mjs"), "export const value = 3\n")
    const result = fence.check({ writeTargets: ["src.mjs"] })
    assert.equal(result.allowed, false)
    assert.equal(result.status, "denied")
    assert.ok(result.reasons.includes(PREWRITE_FENCE_REASON.WORKSPACE_MUTATED))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prewrite-fence: unavailable state is not-applicable, never allowed", () => {
  const result = evaluatePrewriteFence({
    before: { available: false },
    after: { available: false },
    writeTargets: ["a.mjs"],
  })
  assert.equal(result.allowed, false)
  assert.equal(result.status, "not-applicable")
  assert.ok(result.reasons.includes(PREWRITE_FENCE_REASON.NO_PROOF))
})

test("prewrite-fence: rejects generated, escaping and out-of-scope targets", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const fence = createPrewriteFence({ owner })
    fence.armBefore()
    const generated = fence.check({ writeTargets: ["dist/out.mjs"] })
    assert.ok(generated.rejectedTargets.some((row) => row.reason === PREWRITE_FENCE_REASON.GENERATED_TARGET))
    const escape = fence.check({ writeTargets: ["../evil.mjs"] })
    assert.ok(escape.rejectedTargets.some((row) => row.reason === PREWRITE_FENCE_REASON.PATH_OUTSIDE_SCOPE))
    const scope = fence.check({ writeTargets: ["other.mjs"], allowedTargets: ["src.mjs"] })
    assert.ok(scope.rejectedTargets.some((row) => row.reason === PREWRITE_FENCE_REASON.PATH_OUTSIDE_SCOPE))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prewrite-fence: advisor-not-accepted denies without a workspace reason", () => {
  const root = fixture()
  try {
    const owner = createWorkspaceStateOwner({ root })
    const fence = createPrewriteFence({ owner })
    fence.armBefore()
    const result = fence.check({ writeTargets: ["src.mjs"], advisorAccepted: false })
    assert.equal(result.allowed, false)
    assert.ok(result.reasons.includes(PREWRITE_FENCE_REASON.ADVISOR_NOT_ACCEPTED))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace-state-owner: policy constant is stable", () => {
  assert.equal(WORKSPACE_STATE_OWNER_POLICY, "workspace-state-owner-v16-9")
})
