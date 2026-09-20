#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
const explicit = process.argv[2] || process.env.GITHUB_REF_NAME || ""
const tag = String(explicit).trim()

if (!tag || !tag.startsWith("v")) {
  console.error("[release] Refusing publish without an explicit v* release tag; package version is " + pkg.version + ".")
  process.exit(1)
}

const expected = "v" + pkg.version
if (tag !== expected) {
  console.error("[release] Tag/package mismatch: tag=" + tag + ", expected=" + expected)
  process.exit(1)
}

console.log("[release] Tag matches package version: " + tag)
