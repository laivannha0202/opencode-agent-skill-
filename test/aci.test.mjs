import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { aciReferences, aciSearch, aciTextSearch, aciView } from "../lib/aci.mjs"

test("ACI returns bounded evidence and rejects repository escape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-aci-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "service.mjs"), [
      "export function loadAccount(id) {",
      "  const accountMarker = \"tenant-account-marker\"",
      "  return { id, accountMarker }",
      "}",
      "",
    ].join("\n"))

    const search = await aciSearch(root, "loadAccount")
    assert.equal(search.contract.evidenceOnly, true)
    assert.equal(search.results[0].path, "src/service.mjs")

    const refs = await aciReferences(root, "loadAccount")
    assert.equal(refs.evidenceLevel, "syntax-aware-lexical")
    assert.ok(refs.results.some((item) => item.path === "src/service.mjs" && item.definitions.length > 0))

    const text = await aciTextSearch(root, "tenant-account-marker")
    assert.equal(text.evidenceLevel, "exact-text")
    assert.ok(text.matches.some((item) => item.path === "src/service.mjs"))

    const view = await aciView(root, "src/service.mjs", { line: 2, lines: 3 })
    assert.equal(view.path, "src/service.mjs")
    assert.ok(view.text.includes("tenant-account-marker"))

    await assert.rejects(
      aciView(root, "../outside.txt"),
      /path escapes repository root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
