import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V10 global context stays compact without deleting correctness invariants", async () => {
  const source = await readFile(path.join(root, "global-config", "AGENTS.md"), "utf8")
  assert.ok(source.length <= 8_000, "always-loaded AGENTS.md exceeded the V10 8k-character guard")
  assert.match(source, /minimum context/i)
  assert.match(source, /Exact-contract discipline/)
  assert.match(source, /Failure and weak-model recovery/)
  assert.match(source, /Verification gate/)
  assert.match(source, /Long-horizon work/)
  assert.match(source, /Safety/)
  assert.doesNotMatch(source, /load .*engineering-orchestrator.*first/i)
})
