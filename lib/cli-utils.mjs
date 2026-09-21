import { readFileSync } from "node:fs"
import path from "node:path"

export function clipOutput(value, { head = 8000, tail = 8000 } = {}) {
  const text = String(value ?? "")
  if (text.length <= head + tail) return text
  return text.slice(0, head) + "\n...[truncated]\n" + text.slice(-tail)
}

export function positionalArg(args, index) {
  const value = args[index]
  if (value == null || value === "" || value === "--" || value.startsWith("--")) return null
  return value
}

export function readJsonFile(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

export function readTextFile(file) {
  return readFileSync(path.resolve(file), "utf8")
}

export function optionInt(args, name, fallback) {
  const index = args.indexOf(name)
  const raw = index >= 0 ? args[index + 1] : null
  return Number.parseInt(raw || String(fallback), 10)
}

export function optionIntOrUndefined(args, name) {
  return optionInt(args, name, 0) || undefined
}

export function optionValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : error
}