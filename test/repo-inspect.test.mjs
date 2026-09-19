import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { detectStack, detectTestCommands, impactMap, repoMap } from "../lib/repo-inspect.mjs"

test("repository inspection detects stack, verification commands and impact evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ues-inspect-"))
  try {
    await mkdir(path.join(temp, "src"), { recursive: true })
    await writeFile(path.join(temp, "package.json"), JSON.stringify({
      name: "fixture",
      scripts: { test: "node --test", lint: "eslint .", build: "tsc -p ." },
      dependencies: { react: "19.0.0" },
      devDependencies: { typescript: "5.9.0" },
    }, null, 2))
    await writeFile(path.join(temp, "package-lock.json"), "{}")
    await writeFile(path.join(temp, "src", "orders.ts"), "export const calculateOrderTotal = () => 42\n")

    const stack = await detectStack(temp)
    assert.equal(stack.packageManager, "npm")
    assert.ok(stack.stacks.includes("node"))
    assert.ok(stack.stacks.includes("react"))
    assert.ok(stack.stacks.includes("typescript"))

    const commands = await detectTestCommands(temp)
    assert.ok(commands.some((item) => item.command === "npm run test"))
    assert.ok(commands.some((item) => item.command === "npm run lint"))

    const impact = await impactMap(temp, "calculateOrderTotal")
    assert.equal(impact.matches.length, 1)
    assert.equal(impact.matches[0].path, path.join("src", "orders.ts"))

    const map = await repoMap(temp)
    assert.ok(map.important.includes("package.json"))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
