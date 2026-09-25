#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const extensionFiles = [
  "pi/extensions/ues.ts",
  "pi/extensions/ues-child-runtime.ts",
]

function parseNamedLibImports(source) {
  const rows = []
  const pattern = /import\s*\{([\s\S]*?)\}\s*from\s*["'](\.\.\/\.\.\/lib\/[^"']+\.mjs)["']\s*;?/g
  let match
  while ((match = pattern.exec(source))) {
    const names = match[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const parts = value.split(/\s+as\s+/)
        return { imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() }
      })
    rows.push({ specifier: match[2], names })
  }
  return rows
}

const failures = []
let checked = 0
for (const relative of extensionFiles) {
  const absolute = path.join(root, ...relative.split("/"))
  const source = await readFile(absolute, "utf8")
  for (const row of parseNamedLibImports(source)) {
    const modulePath = path.resolve(path.dirname(absolute), row.specifier)
    let imported
    try {
      imported = await import(pathToFileURL(modulePath).href)
    } catch (error) {
      failures.push(
        `${relative}: unable to import ${row.specifier}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    for (const name of row.names) {
      checked += 1
      if (!(name.imported in imported)) {
        failures.push(
          `${relative}: ${row.specifier} does not export named binding ${name.imported}`,
        )
      }
    }
  }
}

assert.deepEqual(
  failures,
  [],
  "Pi extension runtime import/export validation failed:\n" +
    failures.map((item) => "- " + item).join("\n"),
)

console.log(`Runtime exports passed for ${checked} Pi-extension named imports.`)
