import test from "node:test"
import assert from "node:assert/strict"

import {
  isUesRuntimeArtifactPath,
  sourceFacingPaths,
  sourceGitPathspecs,
} from "../lib/runtime-artifacts.mjs"

test("V15.9 runtime artifact filter excludes UES state but preserves real source files", () => {
  const filtered = sourceFacingPaths([
    ".ues-traces/ues-run.jsonl",
    ".ues-cache/probe.test.mjs",
    ".ues-services/api.json",
    ".ues-work/state.json",
    "apps/mobile/package.json",
    "apps/mobile/src/App.tsx",
  ])

  assert.deepEqual(filtered, [
    "apps/mobile/package.json",
    "apps/mobile/src/App.tsx",
  ])
  assert.equal(isUesRuntimeArtifactPath(".ues-traces/run.jsonl"), true)
  assert.equal(isUesRuntimeArtifactPath("apps/mobile/package.json"), false)
  assert.ok(sourceGitPathspecs().includes(":(exclude).ues-traces/**"))
})

test("V15.9 runtime filter normalizes Windows separators", () => {
  assert.equal(isUesRuntimeArtifactPath(".ues-traces\\run.jsonl"), true)
  assert.deepEqual(sourceFacingPaths([".ues-work\\state.json", "src\\index.ts"]), ["src/index.ts"])
})
