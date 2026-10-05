import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  extractCriticalIntegrityFailures,
  onlyIntentionallyDisabledWorkflowFailures,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.7.1 no-actions integrity: all GitHub Actions workflow files stay absent", () => {
  for (const file of ["ci.yml", "publish.yml", "security.yml"]) {
    assert.equal(existsSync(path.join(ROOT, ".github", "workflows", file)), false, file)
  }
})

test("V16.7.1 no-actions integrity: exactly the two retired workflow contracts are tolerated", () => {
  const sample = [
    "AssertionError [ERR_ASSERTION]: Critical UES source-integrity validation failed:",
    "- .github/workflows/security.yml: unreadable (ENOENT: no such file or directory)",
    "- .github/workflows/publish.yml: unreadable (ENOENT: no such file or directory)",
    "+ actual - expected",
  ].join("\n")
  const failures = extractCriticalIntegrityFailures(sample)
  assert.equal(failures.length, 2)
  assert.equal(onlyIntentionallyDisabledWorkflowFailures(failures), true)
})

test("V16.7.1 no-actions integrity: any additional integrity failure still fails closed", () => {
  const failures = [
    ".github/workflows/security.yml: unreadable (ENOENT: disabled)",
    ".github/workflows/publish.yml: unreadable (ENOENT: disabled)",
    "pi/extensions/ues.ts: too small",
  ]
  assert.equal(onlyIntentionallyDisabledWorkflowFailures(failures), false)
})

test("V16.7.1 no-actions integrity: one missing retired contract alone is not silently ignored", () => {
  assert.equal(
    onlyIntentionallyDisabledWorkflowFailures([
      ".github/workflows/security.yml: unreadable (ENOENT: disabled)",
    ]),
    false,
  )
})
