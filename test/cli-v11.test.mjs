import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "bin", "ocskill.mjs")

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

test("V11 CLI exposes capability and visual deterministic helpers", () => {
  const cap = run(["capabilities", "match this screenshot in the browser"])
  assert.equal(cap.status, 0, cap.stderr)
  const parsed = JSON.parse(cap.stdout)
  assert.equal(parsed.required.vision, true)
  assert.equal(parsed.required.browser, true)

  const viewports = run(["visual", "viewports"])
  assert.equal(viewports.status, 0, viewports.stderr)
  assert.equal(JSON.parse(viewports.stdout).length, 4)
})

test("V11 CLI skill lint sees the expanded progressive-disclosure catalog", () => {
  const result = run(["skills", "lint", root])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.ok(parsed.skillCount >= 48)
  assert.equal(parsed.valid, true)
})

test("V11 workflow-plan emits bounded deterministic and agent waves", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v11-cli-"))
  try {
    const file = path.join(dir, "PLAN.json")
    await writeFile(file, JSON.stringify({ tasks: [
      { id: "A", title: "build index", deterministic: true, files: [] },
      { id: "B", title: "implement UI", dependsOn: ["A"], files: { modify: ["ui.js"] } },
    ] }))
    const result = run(["workflow-plan", file, "--max-concurrent", "2"], dir)
    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.taskCount, 2)
    assert.equal(parsed.deterministicTaskCount, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
