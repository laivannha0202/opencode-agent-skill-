import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V13 exposes a valid Pi package manifest", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  assert.ok(pkg.keywords.includes("pi-package"))
  assert.deepEqual(pkg.pi.extensions, ["./pi/extensions/ues-adapter.ts"])
  assert.deepEqual(pkg.pi.skills, ["./global-config/skills"])
  assert.deepEqual(pkg.pi.prompts, ["./pi/prompts"])
  assert.ok(pkg.files.includes("pi/"))

  assert.ok(existsSync(path.join(root, "pi", "extensions", "ues-adapter.ts")))
  assert.ok(existsSync(path.join(root, "global-config", "skills")))
  assert.ok(existsSync(path.join(root, "pi", "prompts")))
})

test("V13 ships the Pi UES prompt surface", () => {
  const promptDir = path.join(root, "pi", "prompts")
  const prompts = readdirSync(promptDir).filter((name) => name.endsWith(".md")).sort()
  assert.deepEqual(prompts, [
    "ues-audit.md",
    "ues-critique.md",
    "ues-debug.md",
    "ues-feature.md",
    "ues-fix.md",
    "ues-plan.md",
    "ues-research.md",
    "ues-resume.md",
    "ues-review.md",
    "ues-run.md",
    "ues-verify.md",
  ])

  for (const name of prompts) {
    const source = readFileSync(path.join(promptDir, name), "utf8")
    assert.match(source, /^---\n/)
    assert.match(source, /description:/)
  }
})

test("Pi adapter keeps destructive commands gated and exposes fresh contexts", () => {
  const source = readFileSync(path.join(root, "pi", "extensions", "ues-adapter.ts"), "utf8")
  assert.match(source, /ues_fresh_agent/)
  assert.match(source, /--no-session/)
  assert.match(source, /read,grep,find,ls/)
  assert.match(source, /npm\\s\+publish/)
  assert.match(source, /reset\\s\+--hard/)
  assert.match(source, /drop\\s\+\(\?:database\|schema\|table\)/)
})
