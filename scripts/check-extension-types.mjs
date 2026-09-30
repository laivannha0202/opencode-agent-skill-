// Syntax gate for the Pi extension TypeScript sources.
//
// THE GAP THIS CLOSES
//
// `npm run syntax` walked only `bin/ lib/ scripts/ test/ evals/`, so every
// extension in `pi/extensions/` was outside it. A malformed string literal in
// `ues.ts` therefore shipped as far as `smoke:pi`, which is a packaging run that
// provisions the Pi SDK from the network -- far too late, far too expensive, and
// not a syntax gate at all.
//
// THE SMALLEST DETERMINISTIC FIX
//
// Node's own `module.stripTypeScriptTypes` parses a TypeScript source with the
// TypeScript parser that ships inside the runtime (the same one
// `--experimental-strip-types` uses). It is already a hard dependency of this
// package's declared engine (`node >= 22.19`), so this adds NO new dependency
// and NO build step: a source is either parseable TypeScript or it is not.
//
// A syntax error is detected by PARSING, not by loading: the file is never
// imported and never executed, so a malformed extension cannot have side effects
// during the check.

import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { stripTypeScriptTypes } from "node:module"

export const EXTENSION_SYNTAX_MIN_NODE = "22.19.0"

// Parse one TypeScript source. Returns `null` when it is valid, or a message
// describing the first syntax error. Never throws for a malformed file: a
// malformed file is the normal case this function exists to report.
export function extensionSyntaxError(source, file = "<inline>") {
  if (typeof stripTypeScriptTypes !== "function") {
    throw new Error(
      `node:module.stripTypeScriptTypes is unavailable; the extension syntax gate needs Node >= ${EXTENSION_SYNTAX_MIN_NODE}`,
    )
  }
  try {
    // `stripTypeScriptTypes` emits an ExperimentalWarning on first use. The
    // gate runs it once per extension, and a gate that prints a warning on every
    // clean run trains people to ignore its output. The warning is suppressed for
    // exactly this call, and the original emitter is restored immediately.
    const previousEmit = process.emitWarning
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : String(warning?.message || warning)
      if (text.includes("stripTypeScriptTypes")) return
      return previousEmit.call(process, warning, ...rest)
    }
    try {
      stripTypeScriptTypes(String(source ?? ""), { mode: "strip" })
    } finally {
      process.emitWarning = previousEmit
    }
    return null
  } catch (error) {
    const message = String(error?.message || error)
    return `${file}: ${message}`
  }
}

// Check every file in a directory. Deterministic: files are sorted, and the
// first error in sorted order is the one reported first.
export async function checkExtensionSyntax(directory, files) {
  const names = files && files.length ? files.map((name) => path.basename(name)) : null
  let list = names ? names.map((name) => path.join(directory, name)) : []
  if (!list.length) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    list = entries
      .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
  }
  if (!list.length) return { checked: 0, errors: [] }
  const errors = []
  for (const file of list.sort()) {
    const source = await readFile(file, "utf8").catch(() => null)
    if (source == null) {
      errors.push(`${file}: unreadable`)
      continue
    }
    const error = extensionSyntaxError(source, path.basename(file))
    if (error) errors.push(error)
  }
  return { checked: list.length, errors }
}