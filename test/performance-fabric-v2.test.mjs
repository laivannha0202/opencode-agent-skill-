import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compactReversibleOutput, reduceCommandOutput } from "../lib/performance-fabric.mjs"
import { getEvidenceSelected } from "../lib/evidence-store.mjs"

test("command-aware reducer registry recognizes high-noise engineering commands", () => {
  const cases = [
    ["npm test", "npm-test", "FAIL suite"],
    ["pytest -q", "pytest", "FAILED tests/test_api.py::test_case"],
    ["git status --short", "git-status", " M src/a.js\n?? src/new.js"],
    ["git log -5 --oneline", "git-log", "commit abcdef1234567890\n    tighten runtime"],
    ["git diff --stat", "git-diff", "diff --git a/a.js b/a.js"],
    ["rg TODO src", "ripgrep", "src/a.js:12:TODO fix"],
    ["tree src", "tree", "src\n├── a.js\n└── b.js"],
    ["npx tsc --noEmit", "tsc", "src/a.ts(1,1): error TS2322: bad"],
    ["npx eslint .", "eslint", "  2:4  error  Unexpected token"],
    ["docker compose up", "docker", "service api failed: error"],
    ["npx prisma migrate dev", "prisma", "Prisma schema loaded from prisma/schema.prisma"],
    ["npm install", "package-install", "added 14 packages, and audited 320 packages in 2s"],
    ["go test ./...", "verification-test", "ok example/pkg 0.12s"],
    ["cargo test", "verification-test", "test result: ok. 12 passed; 0 failed"],
    ["ruff check .", "python-lint", "All checks passed!"],
  ]
  for (const [command, family, output] of cases) {
    assert.equal(reduceCommandOutput(output, { command }).family, family, command)
  }
})

test("command-aware compaction preserves exact raw evidence before reducing model-visible output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-command-compression-v2-"))
  try {
    const raw = Array.from({ length: 700 }, (_, index) =>
      index % 70 === 0
        ? `FAIL src/example-${index}.test.js expected true received false`
        : `noise line ${index} package download progress and verbose runner chatter`
    ).join("\n")
    const result = await compactReversibleOutput(root, raw, {
      command: "npm test",
      source: "npm test",
      maxChars: 8192,
    })
    assert.equal(result.compacted, true)
    assert.equal(result.commandFamily, "npm-test")
    assert.equal(result.strategy, "reversible-head-test-tail")
    assert.match(result.strategyV2, /command-aware-npm-test/)
    assert.ok(result.evidenceRef)
    assert.match(result.text, /Raw captured output:/)

    const recovered = await getEvidenceSelected(root, result.evidenceRef, {
      start: 0,
      maxBytes: 64 * 1024,
    })
    assert.equal(recovered.content, raw)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
