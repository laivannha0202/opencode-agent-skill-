import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V14 contract fixture covers context, memory, capability fallback and contamination", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, "evals", "v14", "tasks.json"), "utf8"))
  assert.equal(fixture.schemaVersion, 1)
  assert.ok(fixture.tasks.length >= 5)
  const ids = new Set(fixture.tasks.map((item) => item.id))
  for (const id of ["hierarchy-scope", "verified-memory", "memory-supersession", "provider-failover", "context-contamination"]) {
    assert.equal(ids.has(id), true)
  }
})
