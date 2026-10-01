import test from "node:test"
import assert from "node:assert/strict"
import { fastStaticVerificationCandidates } from "../lib/fast-static-verification.mjs"

test("V16 fast static candidate selection keeps one typed source target", () => {
  assert.deepEqual(
    fastStaticVerificationCandidates({ changedFiles: ["src/demo.ts"] }),
    ["src/demo.ts"],
  )
})

test("V16 fast static candidate selection ignores non-code artifacts", () => {
  assert.deepEqual(
    fastStaticVerificationCandidates({
      changedFiles: ["README.md", "docs/notes.txt"],
    }),
    [],
  )
})

test("V16 fast static candidate selection preserves multiple typed files so the gate can fail closed", () => {
  assert.deepEqual(
    fastStaticVerificationCandidates({ changedFiles: ["src/a.ts", "src/b.ts"] }),
    ["src/a.ts", "src/b.ts"],
  )
})
