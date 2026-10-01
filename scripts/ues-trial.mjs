#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const input = process.argv.slice(2)
const args = [...input]
const has = (name) => args.includes(name)
if (!has("--mode")) args.push("--mode", "both")
if (!has("--trials")) args.push("--trials", "3")
if (!has("--suite")) args.push("--suite", "live")
if (!has("--keep")) args.push("--keep")

console.error("[ues trial] paired baseline vs UES; deterministic release tests are not substituted for real-model evidence")
const result = spawnSync(process.execPath, [path.join(root, "scripts", "eval-pi.mjs"), ...args], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
})
process.exitCode = result.status ?? 1
