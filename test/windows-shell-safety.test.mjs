import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Windows command wrappers do not use shell-based fallback execution", async () => {
  const cli = await readFile(path.join(root, "bin", "ocskill.mjs"), "utf8")
  const plugin = await readFile(path.join(root, "global-config", "plugins", "ues-router", "index.js"), "utf8")
  assert.ok(!cli.includes("spawnSync(process.env.ComSpec"))
  assert.ok(!plugin.includes('shell: process.platform === "win32"'))
  assert.match(cli, /Refusing to execute an unrecognized Windows batch shim/)
  assert.match(plugin, /refusing to execute an unrecognized ocskill batch shim/)
})
