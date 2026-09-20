import { spawnSync } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import assert from "node:assert/strict"

test("install and remove are idempotent, recursive and preserve user AGENTS content", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?test=${Date.now()}`)
  const globalAgents = path.join(temp, "AGENTS.md")

  await writeFile(globalAgents, "# My own rules\n", "utf8")

  const first = await module.installResources()
  assert.ok(first.skills.length >= 39)
  assert.ok(first.commands.length >= 11)
  assert.ok(first.agents.length >= 10)

  await access(
    path.join(
      temp,
      "skills",
      "ues-engineering-orchestrator",
      "references",
      "routing.md",
    ),
  )
  await access(
    path.join(
      temp,
      "skills",
      "ues-engineering-orchestrator",
      "references",
      "evaluator-loop.md",
    ),
  )
  await access(
    path.join(
      temp,
      "skills",
      "ues-long-task-state",
      "references",
      "context-ledger.md",
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


test("re-sync removes stale managed resources recorded by an older state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-stale-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?stale=${Date.now()}`)
  const first = await module.installResources()

  const staleDir = path.join(temp, "skills", "ues-stale-example")
  const { mkdir, rm } = await import("node:fs/promises")
  await mkdir(staleDir, { recursive: true })
  await writeFile(
    path.join(staleDir, "SKILL.md"),
    "---\nname: ues-stale-example\ndescription: stale\n---\n\n<!-- managed-by: @laivannha0202/opencode-agent-skill -->\n",
    "utf8",
  )

  const stateFile = path.join(temp, ".ues", "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.skills.push("ues-stale-example")
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8")

  await module.installResources()

  await assert.rejects(access(path.join(staleDir, "SKILL.md")))
  const status = await module.getStatus()
  assert.equal(status.skillsPresent, first.skills.length)

  await module.removeResources()
  await rm(temp, { recursive: true, force: true })
})

test("malformed state never turns into arbitrary managed paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-state-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?state=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.skills.push("../../outside")
  state.commands.push("../outside.md")
  state.agents.push("not-ues.md")
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8")

  const status = await module.getStatus()
  assert.equal(status.skills.includes("../../outside"), false)
  assert.equal(status.commands.includes("../outside.md"), false)
  assert.equal(status.agents.includes("not-ues.md"), false)

  await module.removeResources()
})

test("install and remove never clobber state owned by another package", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-foreign-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?foreign=${Date.now()}`)
  await module.installResources()

  const foreign = {
    schemaVersion: 1,
    package: "@different/vendor-package",
    version: "1.0.0",
    skills: [],
    commands: [],
    agents: [],
  }
  const stateFile = path.join(temp, ".ues", "state.json")
  const before = JSON.stringify(foreign, null, 2) + "\n"
  await writeFile(stateFile, before, "utf8")

  const installResult = await module.installResources()
  assert.equal(await readFile(stateFile, "utf8"), before)
  assert.equal(installResult.skills.length, 0)
  assert.ok(installResult.stateError.includes("another package"))
  assert.ok(installResult.warnings.some((warning) => warning.includes("another package")))

  const removeResult = await module.removeResources()
  assert.equal(await readFile(stateFile, "utf8"), before)
  assert.ok(removeResult.stateError.includes("another package"))
  assert.ok(removeResult.warnings.some((warning) => warning.includes("another package")))
  assert.match(
    await readFile(path.join(temp, "AGENTS.md"), "utf8"),
    /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/,
  )

  await rm(temp, { recursive: true, force: true })
})

test("legacy UES state without a package field still re-syncs and is re-owned", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-legacy-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?legacy=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const legacy = JSON.parse(await readFile(stateFile, "utf8"))
  delete legacy.package
  await writeFile(stateFile, JSON.stringify(legacy, null, 2) + "\n", "utf8")

  const result = await module.installResources()
  assert.ok(result.skills.length >= 39)

  const reowned = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(reowned.package, module.PACKAGE_NAME)

  await rm(temp, { recursive: true, force: true })
})

test("renamed package accepts scoped legacy state without force", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-package-rename-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?package-rename=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.package = module.LEGACY_PACKAGE_NAME
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8")

  const result = await module.installResources()
  assert.equal(result.stateError, undefined)

  const migrated = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(migrated.package, module.PACKAGE_NAME)

  await rm(temp, { recursive: true, force: true })
})

test("renamed package migrates legacy managed markers", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-marker-migration-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?marker-migration=${Date.now()}`)
  await module.installResources()

  const skillFile = path.join(temp, "skills", "ues-repo-explorer", "SKILL.md")
  const current = await readFile(skillFile, "utf8")
  await writeFile(
    skillFile,
    current.replace(module.MANAGED_MARKER, module.LEGACY_MANAGED_MARKER),
    "utf8",
  )

  const result = await module.installResources()
  assert.equal(result.stateError, undefined)

  const migrated = await readFile(skillFile, "utf8")
  assert.match(migrated, /managed-by: opencode-agent-skill/)
  assert.doesNotMatch(migrated, /managed-by: @laivannha0202\/opencode-agent-skill/)

  await rm(temp, { recursive: true, force: true })
})

test("installer skips command and agent sources whose IDs are not managed-safe", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-invalid-id-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const bundle = path.join(temp, "bundle")
  const bundleConfig = path.join(bundle, "global-config")
  await mkdir(path.join(bundleConfig, "skills"), { recursive: true })
  await mkdir(path.join(bundleConfig, "commands"), { recursive: true })
  await mkdir(path.join(bundleConfig, "agents"), { recursive: true })

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  await cp(path.join(repoRoot, "global-config", "AGENTS.md"), path.join(bundleConfig, "AGENTS.md"))
  await cp(path.join(repoRoot, "package.json"), path.join(bundle, "package.json"))
  await cp(path.join(repoRoot, "lib"), path.join(bundle, "lib"), { recursive: true })

  await writeFile(path.join(bundleConfig, "commands", "my_cmd.md"), "# bad punctuation\n", "utf8")
  await writeFile(path.join(bundleConfig, "commands", "good-cmd.md"), "# good command\n", "utf8")
  await writeFile(path.join(bundleConfig, "agents", "MyAgent.md"), "# bad casing\n", "utf8")
  await writeFile(path.join(bundleConfig, "agents", "good-agent.md"), "# good agent\n", "utf8")

  const module = await import(
    `${pathToFileURL(path.join(bundle, "lib", "installer.mjs")).href}?invalid-id=${Date.now()}`,
  )
  const result = await module.installResources()

  assert.ok(result.warnings.some((warning) => warning.includes("my_cmd")))
  assert.ok(result.warnings.some((warning) => warning.includes("MyAgent")))
  assert.ok(!result.commands.includes("ues-my_cmd.md"))
  assert.ok(!result.agents.includes("ues-MyAgent.md"))
  assert.ok(result.commands.includes("ues-good-cmd.md"))
  assert.ok(result.agents.includes("ues-good-agent.md"))

  await assert.rejects(access(path.join(temp, "commands", "ues-my_cmd.md")))
  await assert.rejects(access(path.join(temp, "agents", "ues-MyAgent.md")))
  await access(path.join(temp, "agents", "ues-good-agent.md"))

  const state = JSON.parse(await readFile(path.join(temp, ".ues", "state.json"), "utf8"))
  assert.ok(!state.commands.includes("ues-my_cmd.md"))
  assert.ok(!state.agents.includes("ues-MyAgent.md"))

  await rm(temp, { recursive: true, force: true })
})

test("validate rejects command and agent sources whose IDs are not managed-safe", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-validate-id-"))
  const bundleConfig = path.join(temp, "global-config")
  await mkdir(path.join(bundleConfig, "skills", "valid-skill"), { recursive: true })
  await mkdir(path.join(bundleConfig, "commands"), { recursive: true })
  await mkdir(path.join(bundleConfig, "agents"), { recursive: true })

  await writeFile(
    path.join(bundleConfig, "skills", "valid-skill", "SKILL.md"),
    "name: valid-skill\ndescription: demo\n",
    "utf8",
  )
  await writeFile(path.join(bundleConfig, "commands", "good-cmd.md"), "# c\ndescription: ok\n", "utf8")
  await writeFile(path.join(bundleConfig, "commands", "my_cmd.md"), "# c\ndescription: bad\n", "utf8")
  await writeFile(
    path.join(bundleConfig, "agents", "good-agent.md"),
    "# a\ndescription: ok\nmode: subagent\n",
    "utf8",
  )
  await writeFile(
    path.join(bundleConfig, "agents", "MyAgent.md"),
    "# a\ndescription: bad\nmode: subagent\n",
    "utf8",
  )

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const run = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "validate.mjs")], {
    env: { ...process.env, UES_BUNDLE_ROOT: temp },
    encoding: "utf8",
    cwd: repoRoot,
  })

  assert.equal(run.status, 1)
  assert.match(run.stderr, /invalid command id/)
  assert.match(run.stderr, /invalid agent id/)

  await rm(temp, { recursive: true, force: true })
})

test("unreadable state is backed up, never destroyed, by a repeat install", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-invalid-state-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?invalid-state=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const corrupted = "\uFEFF" + JSON.stringify(
    { package: "@different/vendor-package", version: "1.0.0" },
    null,
    2,
  ) + "\n"
  await writeFile(stateFile, corrupted, "utf8")

  const result = await module.installResources()
  assert.ok(result.warnings.some((warning) => warning.includes("Invalid UES state file")))
  assert.ok(result.warnings.some((warning) => warning.includes("Backed up unreadable state")))

  const backups = (await readdir(path.join(temp, ".ues"))).filter((name) =>
    /^state\.json\.invalid-\d+$/.test(name),
  )
  assert.equal(backups.length, 1)
  assert.equal(await readFile(path.join(temp, ".ues", backups[0]), "utf8"), corrupted)
  const rebuilt = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(rebuilt.package, module.PACKAGE_NAME)
  assert.ok(rebuilt.skills.length >= 39)

  await rm(temp, { recursive: true, force: true })
})

test("removeResources refuses to modify unreadable state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-invalid-remove-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?invalid-remove=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const corrupted = "\uFEFF" + JSON.stringify(
    { package: "@different/vendor-package", version: "1.0.0" },
    null,
    2,
  ) + "\n"
  await writeFile(stateFile, corrupted, "utf8")

  const result = await module.removeResources()
  assert.ok(result.stateError.includes("invalid"))
  assert.equal(result.skills, 0)
  assert.equal(result.commands, 0)
  assert.equal(result.agents, 0)
  assert.equal(await readFile(stateFile, "utf8"), corrupted)
  assert.match(
    await readFile(path.join(temp, "AGENTS.md"), "utf8"),
    /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/,
  )

  await rm(temp, { recursive: true, force: true })
})

test("lifecycle scripts fail loudly and preserve state when it belongs to another package", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-lifecycle-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?lifecycle=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const foreign = JSON.stringify(
    { schemaVersion: 1, package: "@different/vendor-package", version: "1.0.0", skills: [], commands: [], agents: [] },
    null,
    2,
  ) + "\n"
  await writeFile(stateFile, foreign, "utf8")

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const installRun = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "install.mjs")],
    { env: { ...process.env, OPENCODE_CONFIG_DIR: temp, npm_config_global: "true" }, encoding: "utf8" },
  )
  assert.equal(installRun.status, 1)
  assert.match(installRun.stderr, /State belongs to another package/)
  assert.equal(await readFile(stateFile, "utf8"), foreign)

  const uninstallRun = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "uninstall.mjs")],
    { env: { ...process.env, OPENCODE_CONFIG_DIR: temp }, encoding: "utf8" },
  )
  assert.equal(uninstallRun.status, 1)
  assert.match(uninstallRun.stderr, /State belongs to another package/)
  assert.equal(await readFile(stateFile, "utf8"), foreign)
  assert.match(
    await readFile(path.join(temp, "AGENTS.md"), "utf8"),
    /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/,
  )

  await rm(temp, { recursive: true, force: true })
})

test("install --force backs up and re-owns state belonging to another package", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-force-install-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?force-install=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const foreign = JSON.stringify(
    { schemaVersion: 1, package: "@different/vendor-package", version: "1.0.0", skills: [], commands: [], agents: [] },
    null,
    2,
  ) + "\n"
  await writeFile(stateFile, foreign, "utf8")

  const result = await module.installResources({ force: true })
  assert.equal(result.stateError, undefined)
  assert.ok(result.warnings.some((warning) => warning.includes("re-owning")))

  const backup = (await readdir(path.join(temp, ".ues"))).find((name) =>
    /^state\.json\.foreign-\d+$/.test(name),
  )
  assert.ok(backup)
  assert.equal(await readFile(path.join(temp, ".ues", backup), "utf8"), foreign)

  const reowned = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(reowned.package, module.PACKAGE_NAME)
  assert.ok(reowned.skills.length >= 39)

  await rm(temp, { recursive: true, force: true })
})

test("remove --force cleans managed resources even when state belongs to another package", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-force-remove-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const module = await import(`../lib/installer.mjs?force-remove=${Date.now()}`)
  await module.installResources()

  const stateFile = path.join(temp, ".ues", "state.json")
  const foreign = JSON.stringify(
    { schemaVersion: 1, package: "@different/vendor-package", version: "1.0.0", skills: [], commands: [], agents: [] },
    null,
    2,
  ) + "\n"
  await writeFile(stateFile, foreign, "utf8")

  await access(path.join(temp, "skills", "ues-engineering-orchestrator"))

  const result = await module.removeResources({ force: true })
  assert.equal(result.stateError, undefined)
  assert.ok(result.skills >= 39)
  assert.ok(result.agents >= 10)
  assert.ok(
    result.warnings.some((warning) => warning.includes("Backed up state before forced remove")),
  )

  const backup = (await readdir(temp)).find((name) =>
    /^state\.foreign-\d+\.backup\.json$/.test(name),
  )
  assert.ok(backup)
  assert.equal(await readFile(path.join(temp, backup), "utf8"), foreign)

  await assert.rejects(access(path.join(temp, "skills", "ues-engineering-orchestrator")))
  await assert.rejects(access(path.join(temp, ".ues", "state.json")))
  let agents = ""
  try {
    agents = await readFile(path.join(temp, "AGENTS.md"), "utf8")
  } catch {}
  assert.doesNotMatch(agents, /BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM/)

  await rm(temp, { recursive: true, force: true })
})

test("remove --force handles foreign state with no resource directories", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-force-remove-empty-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  const stateFile = path.join(temp, ".ues", "state.json")
  const foreign = JSON.stringify(
    { schemaVersion: 1, package: "@different/vendor-package", version: "1.0.0", skills: [], commands: [], agents: [] },
    null,
    2,
  ) + "\n"
  await mkdir(path.join(temp, ".ues"), { recursive: true })
  await writeFile(stateFile, foreign, "utf8")

  const module = await import(`../lib/installer.mjs?force-remove-empty=${Date.now()}`)
  const result = await module.removeResources({ force: true })
  assert.equal(result.stateError, undefined)
  assert.ok(
    result.warnings.some((warning) => warning.includes("Backed up state before forced remove")),
  )

  const backup = (await readdir(temp)).find((name) =>
    /^state\.foreign-\d+\.backup\.json$/.test(name),
  )
  assert.ok(backup)
  assert.equal(await readFile(path.join(temp, backup), "utf8"), foreign)
  await assert.rejects(access(path.join(temp, ".ues", "state.json")))

  await rm(temp, { recursive: true, force: true })
})

test("OpenCode v2 install uses native permissions and installs managed router plugin", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-v2-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  try {
    const module = await import(`../lib/installer.mjs?v2=${Date.now()}`)
    const result = await module.installResources({ openCodeMajor: 2 })

    assert.equal(result.openCodeMajor, 2)
    assert.deepEqual(result.plugins, ["ues-router/index.js"])

    const reviewer = await readFile(path.join(temp, "agents", "ues-reviewer.md"), "utf8")
    assert.match(reviewer, /permissions:/)
    assert.match(reviewer, /action: edit/)
    assert.doesNotMatch(reviewer, /^permission:/m)

    const plugin = await readFile(path.join(temp, "plugins", "ues-router", "index.js"), "utf8")
    assert.match(plugin, /managed-by: @laivannha0202\/opencode-agent-skill/)
    assert.match(plugin, /name: "dispatch_task"/)
    assert.match(plugin, /ctx\.session\.create/)
    assert.match(plugin, /ctx\.session\.switchAgent/)
    assert.match(plugin, /ctx\.session\.switchModel/)
    assert.match(plugin, /ctx\.session\.wait/)
    await access(path.join(temp, "plugins", "ues-router", "router.js"))
    await access(path.join(temp, "plugins", "ues-router", "safety.js"))

    const executor = await readFile(path.join(temp, "agents", "ues-executor.md"), "utf8")
    assert.match(executor, /permissions:/)
    assert.match(executor, /action: subagent/)
    assert.match(executor, /effect: deny/)
    assert.doesNotMatch(executor, /^permission:/m)

    const router = JSON.parse(await readFile(path.join(temp, ".ues", "router.json"), "utf8"))
    assert.deepEqual(router, { enabled: true, maxSkills: 4 })

    const status = await module.getStatus()
    assert.equal(status.pluginsPresent, 1)

    await module.removeResources()
    await assert.rejects(access(path.join(temp, "plugins", "ues-router", "index.js")))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("switching from OpenCode v2 to v1 removes only the managed router and restores legacy agent syntax", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-v1-v2-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  try {
    const module = await import(`../lib/installer.mjs?v1v2=${Date.now()}`)
    await module.installResources({ openCodeMajor: 2 })
    await access(path.join(temp, "plugins", "ues-router", "index.js"))

    const result = await module.installResources({ openCodeMajor: 1 })
    assert.equal(result.openCodeMajor, 1)
    assert.deepEqual(result.plugins, [])
    await assert.rejects(access(path.join(temp, "plugins", "ues-router", "index.js")))

    const reviewer = await readFile(path.join(temp, "agents", "ues-reviewer.md"), "utf8")
    assert.match(reviewer, /^permission:/m)
    assert.doesNotMatch(reviewer, /^permissions:/m)

    const executor = await readFile(path.join(temp, "agents", "ues-executor.md"), "utf8")
    assert.match(executor, /^permission:/m)
    assert.match(executor, /^  task: deny$/m)
    assert.doesNotMatch(executor, /^permissions:/m)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer preserves an unmanaged OpenCode v2 router plugin directory", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-v2-plugin-collision-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  try {
    const pluginDir = path.join(temp, "plugins", "ues-router")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, "custom.txt"), "keep me\n", "utf8")

    const module = await import(`../lib/installer.mjs?v2-plugin-collision=${Date.now()}`)
    const result = await module.installResources({ openCodeMajor: 2 })

    assert.deepEqual(result.plugins, [])
    assert.ok(result.warnings.some((warning) => warning.includes("unmanaged plugin directory")))
    assert.equal(await readFile(path.join(pluginDir, "custom.txt"), "utf8"), "keep me\n")
    await assert.rejects(access(path.join(pluginDir, "index.js")))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer applies configured model tiers to managed agents without affecting disabled defaults", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-model-policy-"))
  process.env.OPENCODE_CONFIG_DIR = temp

  try {
    const config = await import(`../lib/model-config.mjs?model-policy=${Date.now()}`)
    await config.writeModelPolicy(temp, {
      enabled: true,
      tiers: { standard: "provider/mid", heavy: "provider/strong" },
      roleTiers: { executor: "standard", architect: "heavy" },
    })

    const module = await import(`../lib/installer.mjs?model-policy=${Date.now()}`)
    await module.installResources({ openCodeMajor: 2 })

    const executor = await readFile(path.join(temp, "agents", "ues-executor.md"), "utf8")
    const architect = await readFile(path.join(temp, "agents", "ues-architect.md"), "utf8")
    assert.match(executor, /^model: provider\/mid$/m)
    assert.match(architect, /^model: provider\/strong$/m)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

