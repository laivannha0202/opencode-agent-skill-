import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("install and remove are idempotent and preserve user AGENTS content", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?test=${Date.now()}`)
  const agents = path.join(temp, "AGENTS.md")

  const { writeFile } = await import("node:fs/promises")
  await writeFile(agents, "# My own rules\n", "utf8")

  const first = await module.installResources()
  assert.ok(first.skills.length > 0)
  assert.ok(first.commands.length > 0)

  const afterInstall = await readFile(agents, "utf8")
  assert.match(afterInstall, /# My own rules/)
  assert.match(afterInstall, /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/)

  const second = await module.installResources()
  assert.equal(second.skills.length, first.skills.length)

  await module.removeResources()
  const afterRemove = await readFile(agents, "utf8")
  assert.equal(afterRemove.trim(), "# My own rules")

  const status = await module.getStatus()
  assert.equal(status.installed, false)
})
