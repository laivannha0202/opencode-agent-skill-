// The Pi extension TypeScript sources must be inside the syntax gate.
//
// `npm run syntax` used to walk only the JavaScript roots, so a malformed
// `pi/extensions/*.ts` passed the gate and was caught for the first time by
// `smoke:pi` -- a packaging run that provisions the Pi SDK. These tests assert
// both directions: the real extensions parse, and a deliberately malformed
// fixture does not.
//
// The malformed fixture is written to a temporary directory. Nothing under
// `pi/extensions/` is ever modified, and no extension is imported or executed.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { checkExtensionSyntax, extensionSyntaxError } from "../scripts/check-extension-types.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSIONS = path.join(ROOT, "pi/extensions")

test("G1 the shipped Pi extension sources are valid TypeScript", async () => {
  const report = await checkExtensionSyntax(EXTENSIONS)
  assert.deepEqual(report.errors, [], report.errors.join("\n"))
  assert.ok(report.checked >= 2, `expected at least two extension sources, checked ${report.checked}`)
})

test("G2 a malformed TypeScript extension FAILS the gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-153-tsgate-"))
  try {
    // The defect the previous report described: a broken string literal in
    // `pi/extensions/ues.ts` that only `smoke:pi` could catch.
    await writeFile(path.join(root, "broken.ts"), [
      'export default function activate(pi: unknown) {',
      "  const greeting = \"unterminated",
      "  pi.registerCommand(greeting",
      "}",
      "",
    ].join("\n"), "utf8")
    await writeFile(path.join(root, "good.ts"), [
      "export default function activate(pi: { on(event: string, fn: () => void): void }): void {",
      "  pi.on(\"ready\", () => {})",
      "}",
      "",
    ].join("\n"), "utf8")

    const report = await checkExtensionSyntax(root)
    assert.equal(report.checked, 2)
    assert.equal(report.errors.length, 1, JSON.stringify(report.errors))
    assert.match(report.errors[0], /broken\.ts/)
    assert.match(report.errors[0], /SyntaxError|Expected/i)

    // The well-formed sibling must NOT be reported, so the gate is not simply
    // rejecting everything in a directory.
    assert.equal(report.errors.some((error) => error.includes("good.ts")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("G3 the syntax script itself exits non-zero on a malformed extension", async () => {
  // The gate has to be reachable from `npm run syntax`, not only from a unit
  // test. The script is invoked against a temporary copy of the repository root
  // layout so the real extensions are never touched.
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-153-tsgate-run-"))
  try {
    await mkdir(path.join(root, "pi", "extensions"), { recursive: true })
    await writeFile(path.join(root, "pi", "extensions", "ok.ts"), "export default function activate(): void {}\n", "utf8")
    // A minimal script root with one valid module and one broken extension.
    await mkdir(path.join(root, "scripts"), { recursive: true })
    const { readFile } = await import("node:fs/promises")
    const script = await readFile(path.join(ROOT, "scripts/syntax-check.mjs"), "utf8")
    await writeFile(path.join(root, "scripts/syntax-check.mjs"), script, "utf8")
    const helper = await readFile(path.join(ROOT, "scripts/check-extension-types.mjs"), "utf8")
    await writeFile(path.join(root, "scripts/check-extension-types.mjs"), helper, "utf8")
    for (const dir of ["bin", "lib", "test", "global-config/plugins", "evals/live/graders", "evals/live/fixtures", "evals/long/graders", "evals/long/fixtures"]) {
      await mkdir(path.join(root, ...dir.split("/")), { recursive: true });
    }
    await writeFile(path.join(root, "lib/ok.mjs"), "export const ok = 1\n", "utf8")

    const passing = spawnSync(process.execPath, [path.join(root, "scripts/syntax-check.mjs")], { encoding: "utf8" })
    assert.equal(passing.status, 0, passing.stdout + passing.stderr)

    await writeFile(path.join(root, "pi/extensions/broken.ts"), "export default function activate( {\n", "utf8")
    const failing = spawnSync(process.execPath, [path.join(root, "scripts/syntax-check.mjs")], { encoding: "utf8" })
    assert.equal(failing.status, 1, failing.stdout + failing.stderr)
    assert.match(failing.stderr, /broken\.ts/)
    assert.match(failing.stderr, /syntax validation failed/i)
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})

test("G4 the inline checker reports a message rather than throwing", () => {
  assert.equal(extensionSyntaxError("export const a: number = 1\n"), null)
  assert.equal(
    extensionSyntaxError("const total: number = 1\nexport { total }\n"),
    null,
    "a well-formed annotated module must pass",
  )
  // A type error is not a syntax error: the gate must not become a type checker.
  assert.match(String(extensionSyntaxError("export const s = \"unterminated\n")), /Unterminated/i)
  assert.match(String(extensionSyntaxError("function broken( {\n")), /Expected/i)
  assert.match(String(extensionSyntaxError("export default function activate(pi) {\n  pi.registerCommand(\n")),

    /Expected|Unexpected/i)
})