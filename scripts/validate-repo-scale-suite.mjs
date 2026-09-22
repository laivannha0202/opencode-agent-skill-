#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { generateRepoScaleFixture } from "../lib/repo-scale-fixture.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const suite = JSON.parse(await readFile(path.join(root, "evals", "repo-scale", "tasks.json"), "utf8"))
const errors = []
if (!Array.isArray(suite.tasks) || suite.tasks.length < 4) errors.push("repo-scale suite must define at least 4 tasks")
for (const task of suite.tasks || []) {
  if (!task.id || !task.objective || task.objective.length < 40) errors.push((task.id || "<missing>") + ": objective too weak")
  if (!Array.isArray(task.requiredFiles) || task.requiredFiles.length < 2) errors.push((task.id || "<missing>") + ": requiredFiles must contain at least 2 paths")
  if (!Array.isArray(task.acceptance) || task.acceptance.length < 2) errors.push((task.id || "<missing>") + ": acceptance must contain at least 2 checks")
}
const tmp = await mkdtemp(path.join(os.tmpdir(), "ues-repo-scale-"))
try {
  const generated = await generateRepoScaleFixture(tmp)
  if (generated.generatedModules < Number(suite.minimumGeneratedModules || 300)) errors.push("generated repo too small: " + generated.generatedModules + " modules")
} finally { await rm(tmp, { recursive: true, force: true }) }
if (errors.length) {
  console.error("Repo-scale suite validation failed:")
  for (const error of errors) console.error("- " + error)
  process.exit(1)
}
console.log("Validated repo-scale suite: " + suite.tasks.length + " tasks, >=" + suite.minimumGeneratedModules + " generated modules.")
