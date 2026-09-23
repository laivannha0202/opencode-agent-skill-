import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = path.join(root, "pi", "extensions", "ues.ts")
const skillsPath = path.join(root, "global-config", "skills")
const promptsPath = path.join(root, "pi", "prompts")
const agentDir = path.join(root, ".tmp-pi-agent")

const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  additionalExtensionPaths: [extensionPath],
  additionalSkillPaths: [skillsPath],
  additionalPromptTemplatePaths: [promptsPath],
})

await loader.reload()
const result = loader.getExtensions()

assert.equal(
  result.errors.length,
  0,
  result.errors.map((entry) => `${entry.path}: ${entry.error}`).join("\n"),
)
assert.ok(result.extensions.length >= 1, "Pi did not load the UES extension")

const skillResult = loader.getSkills()
assert.equal(
  skillResult.diagnostics.length,
  0,
  skillResult.diagnostics.map((entry) => `${entry.path || entry.filePath || "skill"}: ${entry.message || entry.error || JSON.stringify(entry)}`).join("\n"),
)
assert.ok(skillResult.skills.length >= 40, "Pi did not load the bundled UES skills")

const promptResult = loader.getPrompts()
assert.equal(
  promptResult.diagnostics.length,
  0,
  promptResult.diagnostics.map((entry) => `${entry.path || entry.filePath || "prompt"}: ${entry.message || entry.error || JSON.stringify(entry)}`).join("\n"),
)
assert.ok(promptResult.prompts.length >= 11, "Pi did not load the bundled UES prompts")

console.log(
  `Pi package smoke passed: ${result.extensions.length} extension(s), ${skillResult.skills.length} skill(s), ${promptResult.prompts.length} prompt(s) loaded`,
)
