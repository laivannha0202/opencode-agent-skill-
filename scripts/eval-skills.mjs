import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skillsRoot = path.join(root, "global-config", "skills")
const evalFile = path.join(root, "evals", "routing.json")

const skillEntries = await readdir(skillsRoot, { withFileTypes: true })
const skillIDs = new Set(skillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
const suite = JSON.parse(await readFile(evalFile, "utf8"))
const errors = []
const names = new Set()
const referenced = new Set()

if (!Array.isArray(suite.scenarios) || suite.scenarios.length < 30) {
  errors.push("routing suite must contain at least 30 scenarios")
}

for (const scenario of suite.scenarios || []) {
  if (!scenario.name || names.has(scenario.name)) {
    errors.push(`invalid or duplicate scenario name: ${scenario.name || "<missing>"}`)
    continue
  }
  names.add(scenario.name)

  if (!scenario.prompt || typeof scenario.prompt !== "string") {
    errors.push(`${scenario.name}: missing prompt`)
  }

  if (!Array.isArray(scenario.expect) || scenario.expect.length === 0) {
    errors.push(`${scenario.name}: expect must contain at least one skill`)
    continue
  }

  if (scenario.expect.length > 5) {
    errors.push(`${scenario.name}: expects more than five skills; routing should stay focused`)
  }

  for (const id of scenario.expect) {
    referenced.add(id)
    if (!skillIDs.has(id)) errors.push(`${scenario.name}: unknown skill ${id}`)
  }
}

if (!referenced.has("engineering-orchestrator")) {
  errors.push("routing suite must exercise engineering-orchestrator")
}
if (!referenced.has("bug-diagnosis")) {
  errors.push("routing suite must exercise bug-diagnosis")
}
if (!referenced.has("test-verification")) {
  errors.push("routing suite must exercise test-verification")
}
if (!referenced.has("research-verification")) {
  errors.push("routing suite must exercise research-verification")
}

for (const id of [...skillIDs].sort()) {
  if (!referenced.has(id)) errors.push(`routing suite does not exercise skill ${id}`)
}

if (errors.length) {
  console.error("Skill routing eval contract failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Validated ${suite.scenarios.length} routing scenarios across ${referenced.size} referenced skills.`,
)
