import test from "node:test"
import assert from "node:assert/strict"
import { resolveLatestPublishedVersion } from "../lib/update-resolver.mjs"

function runner(map) {
  return (_exe, args) => {
    const key = args.join(" ")
    return map[key] || { status: 1, stdout: "", stderr: "missing fixture" }
  }
}

test("update resolver reads the explicit latest dist-tag instead of stale package version metadata", () => {
  const runCapture = runner({
    "view @scope/pkg@latest version --json": { status: 0, stdout: '"4.0.0"\n', stderr: "" },
  })
  assert.deepEqual(
    resolveLatestPublishedVersion({ runCapture, packageName: "@scope/pkg", cwd: "/tmp" }),
    { version: "4.0.0", source: "view@latest" },
  )
})

test("update resolver falls back to dist-tag output when npm view latest is unavailable", () => {
  const runCapture = runner({
    "view @scope/pkg@latest version --json": { status: 1, stdout: "", stderr: "temporary" },
    "dist-tag ls @scope/pkg": { status: 0, stdout: "beta: 4.1.0-beta.1\nlatest: 4.0.0\n", stderr: "" },
  })
  assert.deepEqual(
    resolveLatestPublishedVersion({ runCapture, packageName: "@scope/pkg", cwd: "/tmp" }),
    { version: "4.0.0", source: "dist-tag" },
  )
})
