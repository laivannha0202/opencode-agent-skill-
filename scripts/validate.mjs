import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validResourceID } from "../lib/ids.mjs"

const root = process.env.UES_BUNDLE_ROOT
  ? path.resolve(process.env.UES_BUNDLE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skillsRoot = path.join(root, "global-config", "skills")
const commandsRoot = path.join(root, "global-config", "commands")
const agentsRoot = path.join(root, "global-config", "agents")
const pluginsRoot = path.join(root, "global-config", "plugins")
const errors = []
const ids = new Set()

function localMarkdownLinks(source) {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter((value) =>
      value &&
      !value.startsWith("#") &&
      !value.startsWith("http://") &&
      !value.startsWith("https://") &&
      !value.startsWith("mailto:"),
    )
}

for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const dir = path.join(skillsRoot, entry.name)
  const file = path.join(dir, "SKILL.md")
  if (!existsSync(file)) {
    errors.push(`${entry.name}: missing SKILL.md`)
    continue
  }

  const source = await readFile(file, "utf8")
  const name = source.match(/^name:\s*([^\r\n]+)/m)?.[1]?.trim()
  const description = source.match(/^description:\s*([^\r\n]+)/m)?.[1]?.trim()

  if (!name) errors.push(`${entry.name}: missing name`)
  if (!description) errors.push(`${entry.name}: missing description`)
  if (name && name !== entry.name) errors.push(`${entry.name}: frontmatter name must match directory`)
  if (!validResourceID(entry.name)) errors.push(`${entry.name}: invalid skill id`)
  if (ids.has(entry.name)) errors.push(`${entry.name}: duplicate skill id`)
  ids.add(entry.name)

  for (const link of localMarkdownLinks(source)) {
    const relative = link.split("#", 1)[0]
    if (!relative) continue
    if (!existsSync(path.resolve(dir, relative))) {
      errors.push(`${entry.name}: broken local reference ${link}`)
    }
  }
}

const agentIDs = new Set()
for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  agentIDs.add(`ues-${entry.name.slice(0, -3)}`)
}

let commands = 0
for (const entry of await readdir(commandsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  commands += 1
  const id = entry.name.slice(0, -3)
  if (!validResourceID(id)) errors.push(`${entry.name}: invalid command id`)
  const source = await readFile(path.join(commandsRoot, entry.name), "utf8")
  if (!source.includes("description:")) errors.push(`${entry.name}: missing command description`)
  const agent = source.match(/^agent:\s*([^\r\n]+)/m)?.[1]?.trim()
  if (agent?.startsWith("ues-") && !agentIDs.has(agent)) {
    errors.push(`${entry.name}: references missing subagent ${agent}`)
  }
}

let agents = 0
for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  agents += 1
  const id = entry.name.slice(0, -3)
  if (!validResourceID(id)) errors.push(`${entry.name}: invalid agent id`)
  const source = await readFile(path.join(agentsRoot, entry.name), "utf8")
  if (!source.includes("description:")) errors.push(`${entry.name}: missing agent description`)
  if (!/mode:\s*subagent/.test(source)) errors.push(`${entry.name}: agent must use mode: subagent`)
}

if (ids.size < 39) errors.push(`expected at least 39 skills, found ${ids.size}`)
if (commands < 11) errors.push(`expected at least 11 commands, found ${commands}`)
if (agents < 10) errors.push(`expected at least 10 subagents, found ${agents}`)

const routerIndex = path.join(pluginsRoot, "ues-router", "index.js")
const routerCore = path.join(pluginsRoot, "ues-router", "router.js")
const routerSafety = path.join(pluginsRoot, "ues-router", "safety.js")
const routerCapabilities = path.join(pluginsRoot, "ues-router", "capabilities.js")
if (!existsSync(routerIndex)) errors.push("missing OpenCode v2 router plugin entrypoint")
if (!existsSync(routerCore)) errors.push("missing OpenCode v2 router core")
if (!existsSync(routerSafety)) errors.push("missing OpenCode v2 safety gate")
if (!existsSync(routerCapabilities)) errors.push("missing OpenCode v2 runtime capability probe")
if (existsSync(routerIndex)) {
  const source = await readFile(routerIndex, "utf8")
  if (!source.includes('id: "ues-router"')) errors.push("v2 router plugin must declare stable id ues-router")
  if (!source.includes('ctx.session.hook("prompt"')) errors.push("v2 router plugin must register prompt admission hook")
  if (!source.includes('ctx.session.hook("context"')) errors.push("v2 router plugin must register context guardrail hook")
  if (!source.includes('ctx.permission.hook("evaluate"')) errors.push("v2 router plugin must register permission safety hook")
  if (!source.includes("ctx.tool.transform")) errors.push("v2 router plugin must register UES helper tools")
  if (!source.includes('name: "dispatch_task"')) errors.push("v2 router plugin must expose fresh-context task dispatch")
  if (!source.includes("ctx.session.create")) errors.push("v2 task dispatch must create a fresh session")
  if (!source.includes("ctx.session.switchAgent")) errors.push("v2 task dispatch must select ues-executor")
  if (!source.includes("ctx.session.switchModel")) errors.push("v2 task dispatch must support configured model escalation")
  if (!source.includes("ctx.session.wait")) errors.push("v2 task dispatch must wait for executor completion")
  if (!source.includes('name: "capabilities"')) errors.push("v8 router plugin must expose runtime capability inspection")
  if (!source.includes('name: "task_policy"')) errors.push("v8 router plugin must expose adaptive task policy")
  if (!source.includes('name: "cancel_task"')) errors.push("v8 router plugin must expose executor cancellation")
  if (!source.includes('name: "recover_task"')) errors.push("v8 router plugin must expose task-scoped recovery")
  if (!source.includes("ctx.session.interrupt")) errors.push("v8 task dispatch must interrupt timed-out executors")
  if (!source.includes('"work", "heartbeat"')) errors.push("v8 task dispatch must refresh task leases")
}

for (const name of ["process-runner.mjs","evidence-receipt.mjs","gate-receipt.mjs","runtime-events.mjs","context-manifest.mjs","orchestrator-policy.mjs","worktree-sandbox.mjs","learning-engine.mjs","hermes-bridge.mjs","control-center.mjs"]) {
  if (!existsSync(path.join(root, "lib", name))) errors.push(`missing V8 core module ${name}`)
}

for (const name of ["codebase-mapper.md","plan-checker.md","executor.md","integration-verifier.md"]) {
  if (!existsSync(path.join(agentsRoot, name))) errors.push(`missing V6 subagent ${name}`)
}

if (errors.length) {
  console.error("Validation failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${ids.size} skills, ${commands} commands and ${agents} subagents.`)
