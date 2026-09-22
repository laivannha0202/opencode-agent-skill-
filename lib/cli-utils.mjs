import path from "node:path"
import { readTextAuto } from "./text-encoding.mjs"

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
  return JSON.parse(readTextAuto(path.resolve(file)))
}

export function readTextFile(file) {
  return readTextAuto(path.resolve(file))
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
export function cliErrorPayload(error, options = {}) {
  const message = error instanceof Error ? error.message : String(error)
  const code = String(error?.code || (message.startsWith("Usage:") ? "UES_USAGE" : "UES_ERROR"))
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : code === "UES_USAGE" ? 2 : 1
  return { ok: false, error: { code, message, command: options.command || null, usage: options.usage || (message.startsWith("Usage:") ? message : null), hint: options.hint || null, recoverable: options.recoverable ?? (code === "UES_USAGE" || code === "UES_BINARY_TEXT") }, exitCode }
}

export function usageError(message) {
  const error = new Error(String(message || "invalid command usage"))
  error.code = "UES_USAGE"
  error.exitCode = 2
  return error
}
