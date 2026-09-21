import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { buildContainerSandboxArgs } from "../lib/container-sandbox.mjs"

test("container sandbox arguments fail closed by default", () => {
  const root = path.join(os.tmpdir(), "ues-container-root")
  const args = buildContainerSandboxArgs(root, "node:22", "node", ["--version"])
  assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--init"])
  assert.ok(args.includes("--network"))
  assert.equal(args[args.indexOf("--network") + 1], "none")
  assert.ok(args.includes("--cap-drop"))
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL")
  assert.ok(args.includes("--read-only"))
  assert.ok(args.includes("--pids-limit"))
  assert.ok(args.some((item) => item.includes("target=/workspace")))
  assert.equal(args.at(-2), "node")
  assert.equal(args.at(-1), "--version")
})

test("container sandbox rejects ambiguous image references", () => {
  assert.throws(
    () => buildContainerSandboxArgs(process.cwd(), "node:22; echo bad", "node", []),
    /concrete image reference/,
  )
})
