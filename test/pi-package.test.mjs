import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { lintSkillCatalog, validateFrontmatterSource } from "../lib/skill-quality.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Pi package manifest exposes UES resources", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.equal(pkg.bin?.ues, "bin/ocskill.mjs")
  assert.equal(pkg.bin?.ocskill, "bin/ocskill.mjs")
  assert.equal(pkg.scripts?.["eval:pi"], "node scripts/eval-pi.mjs")
  assert.ok(pkg.files.includes("scripts/"))
  assert.ok(pkg.files.includes("evals/"))
  assert.ok(pkg.files.includes("global-config/plugins/"))
  assert.equal(pkg.pi.extensions[0], "./pi/extensions/ues.ts")
  assert.deepEqual(pkg.pi.skills, ["./global-config/skills"])
  assert.deepEqual(pkg.pi.prompts, ["./pi/prompts/*.md"])
  assert.ok(pkg.keywords.includes("pi-package"))
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*")
  assert.equal(pkg.peerDependencies.typebox, "*")
  assert.equal(pkg.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true)
  assert.equal(pkg.peerDependenciesMeta.typebox.optional, true)
})

test("Pi adapter and prompt resources are packaged", () => {
  const extensionPath = path.join(root, "pi", "extensions", "ues.ts")
  assert.ok(fs.existsSync(extensionPath))

  const source = fs.readFileSync(extensionPath, "utf8")
  assert.match(source, /name:\s*"ues_cli"/)
  assert.match(source, /name:\s*"ues_dispatch"/)
  assert.match(source, /name:\s*"ues_execute"/)
  assert.match(source, /buildAdaptiveTaskContext/)
  assert.match(source, /resolveCapabilityModel/)
  assert.match(source, /computeSafeWaves/)
  assert.match(source, /createTaskSandbox/)
  assert.match(source, /UES_PLAN_JSON/)
  assert.match(source, /recordModelPerformance/)
  assert.match(source, /destructiveShellRisk/)
  assert.match(source, /writer agents require an explicit cwd/i)

  const requiredPrompts = [
    "ues-run.md",
    "ues-plan.md",
    "ues-resume.md",
    "ues-verify.md",
    "ues-review.md",
    "ues-debug.md",
    "ues-fix.md",
    "ues-feature.md",
    "ues-audit.md",
    "ues-research.md",
    "ues-critique.md",
  ]

  for (const file of requiredPrompts) {
    const promptPath = path.join(root, "pi", "prompts", file)
    assert.ok(fs.existsSync(promptPath), `missing Pi prompt: ${file}`)
    const content = fs.readFileSync(promptPath, "utf8")
    assert.match(content, /^---\n/)
    assert.match(content, /description:/)
  }
})

test("existing UES skills remain Agent Skills compatible for Pi", async () => {
  const skillsDir = path.join(root, "global-config", "skills")
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  assert.ok(skillDirs.length >= 40)

  for (const entry of skillDirs) {
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md")
    assert.ok(fs.existsSync(skillFile), `missing SKILL.md for ${entry.name}`)
    const content = fs.readFileSync(skillFile, "utf8")
    assert.match(content, /^---\n/)
    assert.match(content, /\nname:\s*[^\n]+/)
    assert.match(content, /\ndescription:\s*[^\n]+/)
    const yaml = validateFrontmatterSource(content, { file: skillFile })
    assert.equal(yaml.valid, true, JSON.stringify(yaml.errors))
  }

  const lint = await lintSkillCatalog(root)
  assert.equal(lint.valid, true, JSON.stringify(lint.errors))
})

test("Pi prompt frontmatter rejects unquoted colon scalars", () => {
  const promptsDir = path.join(root, "pi", "prompts")
  for (const file of fs.readdirSync(promptsDir).filter((name) => name.endsWith(".md"))) {
    const prompt = path.join(promptsDir, file)
    const content = fs.readFileSync(prompt, "utf8")
    const yaml = validateFrontmatterSource(content, { file: prompt })
    assert.equal(yaml.valid, true, JSON.stringify(yaml.errors))
  }

  const invalid = validateFrontmatterSource("---\nname: demo\ndescription: bad: nested scalar\n---\n")
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.issue === "unquoted-colon-in-scalar"))
})
