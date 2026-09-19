import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const liveRoot = path.join(root, "evals", "live")
const suite = JSON.parse(await readFile(path.join(liveRoot, "tasks.json"), "utf8"))
const errors = []
const ids = new Set()

if (!Array.isArray(suite.tasks) || suite.tasks.length < 20) {
  errors.push("live eval suite must contain at least 20 tasks")
}

for (const task of suite.tasks || []) {
  if (!task.id || ids.has(task.id)) {
    errors.push(`invalid or duplicate live task id: ${task.id || "<missing>"}`)
    continue
  }
  ids.add(task.id)

  if (!task.prompt || typeof task.prompt !== "string" || task.prompt.length < 40) {
    errors.push(`${task.id}: prompt must be a concrete non-trivial string`)
  }

  const fixture = path.join(liveRoot, task.fixture || "")
  const grader = path.join(liveRoot, task.grader || "")
  if (!task.fixture || !existsSync(fixture)) errors.push(`${task.id}: missing fixture ${task.fixture || "<missing>"}`)
  if (!task.grader || !existsSync(grader)) errors.push(`${task.id}: missing grader ${task.grader || "<missing>"}`)
  if (!task.fixture || !task.grader || !existsSync(fixture) || !existsSync(grader)) continue

  const run = spawnSync(process.execPath, [grader], {
    cwd: fixture,
    env: { ...process.env, UES_EVAL_WORKSPACE: fixture, UES_EVAL_TASK: task.id },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })

  if (run.status === 0) {
    errors.push(`${task.id}: hidden grader unexpectedly passes the intentionally broken fixture`)
  } else {
    const diagnostic = `${run.stderr || ""}\n${run.stdout || ""}`
    if (!/AssertionError|ERR_ASSERTION|assert/i.test(diagnostic)) {
      errors.push(`${task.id}: grader failed for a non-assertion reason; check syntax/runtime setup`)
    }
  }
}

if (errors.length) {
  console.error("Live eval suite validation failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${suite.tasks.length} live tasks; every hidden grader rejects its broken fixture.`)
