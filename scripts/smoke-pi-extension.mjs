import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = path.join(root, "pi", "extensions", "ues.ts")
const agentDir = path.join(root, ".tmp-pi-agent")

const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  additionalExtensionPaths: [extensionPath],
})

await loader.reload()
const result = loader.getExtensions()

assert.equal(
  result.errors.length,
  0,
  result.errors.map((entry) => `${entry.path}: ${entry.error}`).join("\n"),
)
assert.ok(result.extensions.length >= 1, "Pi did not load the UES extension")

console.log(`Pi extension smoke passed: ${result.extensions.length} extension(s) loaded`)
