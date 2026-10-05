// V16.7 registry end-to-end: opaque 128-bit ids and id delegation to the registry.
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import test from "node:test"

const { createRandomProfileId, resolveDeepSeekProfileId, activeProfileId } = await import("../lib/deepseek-profile-registry.mjs")

test("E2E: createRandomProfileId yields opaque 128-bit stable ids", () => {
  const id = createRandomProfileId()
  assert.equal(id.length, 32, "128 bits = 32 hex chars")
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.notEqual(createRandomProfileId(), id)
  assert.notEqual(createRandomProfileId().length, 0)
})

test("E2E: resolveDeepSeekProfileId returns the opaque registry id", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-e2e-"))
  try {
    const uesDir = path.join(tmp, "ues") // registry lives at <XDG>/ues/browser-profiles/profiles.json
    const randomId = createRandomProfileId()
    mkdirSync(path.join(uesDir, "browser-profiles"), { recursive: true })
    writeFileSync(path.join(uesDir, "browser-profiles", "profiles.json"), JSON.stringify({
      schemaVersion: 1, policy: "deepseek-profile-registry-v16-7",
      active: "personal", profiles: [{ name: "personal", id: randomId }] 
    }))
    // The registry resolves the config dir from XDG_CONFIG_HOME (cwd is ignored).
    const id = resolveDeepSeekProfileId({ XDG_CONFIG_HOME: tmp }, null)
    assert.equal(id, randomId, "opaque registry id flows through to the cache key")
    assert.notEqual(id, `pr-${crypto.createHash("sha256").update("personal").digest("hex").slice(0, 24)}`,
      "must NOT be a name hash")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("E2E: explicit env override still derives a deterministic legacy id (registry metadata-only)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-e2e-"))
  try {
    const expected = `pr-${crypto.createHash("sha256").update("work").digest("hex").slice(0, 24)}`
    const id = resolveDeepSeekProfileId({ UES_DEEPSEEK_PROFILE: "work" }, tmp)
    assert.equal(id, expected, "explicit env overrides with a deterministic id")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("E2E: missing registry degrades to null", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-e2e-"))
  try {
    const id = resolveDeepSeekProfileId({}, path.join(tmp, "nonexistent"))
    assert.equal(id, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
