import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("install and remove are idempotent, recursive and preserve user AGENTS content", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?test=${Date.now()}`)
  const globalAgents = path.join(temp, "AGENTS.md")

  await writeFile(globalAgents, "# My own rules\n", "utf8")

  const first = await module.installResources()
  assert.ok(first.skills.length >= 39)
  assert.ok(first.commands.length >= 8)
  assert.ok(first.agents.length >= 5)

  await access(
    path.join(
      temp,
      "skills",
      "ues-engineering-orchestrator",
      "references",
      "routing.md",
    ),
  )

  const status = await module.getStatus()
  assert.equal(status.skillsPresent, first.skills.length)
  assert.equal(status.commandsPresent, first.commands.length)
  assert.equal(status.agentsPresent, first.agents.length)
  assert.equal(status.workflowPresent, true)

  const afterInstall = await readFile(globalAgents, "utf8")
  assert.match(afterInstall, /# My own rules/)
  assert.match(afterInstall, /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/)

  const second = await module.installResources()
  assert.equal(second.skills.length, first.skills.length)
  assert.equal(second.commands.length, first.commands.length)
  assert.equal(second.agents.length, first.agents.length)

  await module.removeResources()

  const afterRemove = await readFile(globalAgents, "utf8")
  assert.equal(afterRemove.trim(), "# My own rules")

  const removedStatus = await module.getStatus()
  assert.equal(removedStatus.installed, false)
})

test("installer never overwrites an unmanaged namespaced skill", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-collision-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const target = path.join(temp, "skills", "ues-repo-explorer")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }))
  const unmanaged = "---\nname: ues-repo-explorer\ndescription: user owned\n---\n\nKeep me.\n"
  await writeFile(path.join(target, "SKILL.md"), unmanaged, "utf8")

  const module = await import(`../lib/installer.mjs?collision=${Date.now()}`)
  const result = await module.installResources()

  assert.ok(result.warnings.some((warning) => warning.includes("unmanaged skill")))
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), unmanaged)

  await module.removeResources()
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), unmanaged)
})
