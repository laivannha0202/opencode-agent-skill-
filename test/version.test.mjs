import test from "node:test"
import assert from "node:assert/strict"
import { compareVersions } from "../lib/version.mjs"

test("semantic version comparison protects self-update from downgrades", () => {
  assert.equal(compareVersions("3.0.0", "2.1.0"), 1)
  assert.equal(compareVersions("2.1.0", "3.0.0"), -1)
  assert.equal(compareVersions("3.0.0", "3.0.0"), 0)
  assert.equal(compareVersions("3.0.0", "3.0.0-rc.1"), 1)
  assert.equal(compareVersions("3.0.0-rc.2", "3.0.0-rc.1"), 1)
  assert.equal(compareVersions("3.0.0-rc.1", "3.0.0-rc.1"), 0)
})

test("semantic version comparison rejects malformed versions", () => {
  assert.throws(() => compareVersions("latest", "3.0.0"), /Invalid semantic version/)
})
