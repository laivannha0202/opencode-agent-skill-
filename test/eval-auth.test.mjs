import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyCurrentOpenCodeAuth } from "../lib/eval-auth.mjs"

test("current-auth eval mode copies only the OpenCode auth file into isolated data", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ues-auth-"))
  try {
    const home = path.join(temp, "home")
    const source = path.join(home, ".local", "share", "opencode", "auth.json")
    const data = path.join(temp, "isolated-data")
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, '{"provider":"secret-placeholder"}\n', "utf8")

    const result = await copyCurrentOpenCodeAuth(data, { home })
    assert.equal(result.copied, true)
    assert.equal(
      await readFile(path.join(data, "opencode", "auth.json"), "utf8"),
      '{"provider":"secret-placeholder"}\n',
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
