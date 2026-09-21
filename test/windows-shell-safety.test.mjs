import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Windows command wrappers do not use shell-based fallback execution", async () => {
  const cli = await readFile(path.join(root, "bin", "ocskill.mjs"), "utf8")
  const plugin = await readFile(path.join(root, "global-config", "plugins", "ues-router", "index.js"), "utf8")
  const compat = await readFile(path.join(root, "lib", "opencode-compat.mjs"), "utf8")
  const liveEval = await readFile(path.join(root, "scripts", "eval-live.mjs"), "utf8")
  assert.ok(!cli.includes("process.env.ComSpec"))
  assert.ok(!plugin.includes('shell: process.platform === "win32"'))
  assert.ok(!compat.includes("process.env.ComSpec"))
  assert.ok(!compat.includes('"cmd.exe"'))
  assert.ok(!liveEval.includes("process.env.ComSpec"))
  assert.ok(!liveEval.includes('"cmd.exe"'))
  assert.ok(!liveEval.includes("quoteCmd("))
  assert.match(cli, /No safely executable Windows command found/)
  assert.match(plugin, /refusing to execute an unrecognized ocskill batch shim/)
})
