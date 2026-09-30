// Shared plumbing for the V15.3 benchmarks.
//
// Every benchmark here is deterministic, writes only into a caller-supplied
// temporary directory, and prints exactly one JSON receipt. Two rules are load
// bearing:
//
//  1. A benchmark never changes production code to make its own numbers look
//     good. Fixtures are generated, not hand-tuned, and the expected answers
//     live with the fixture.
//  2. A metric whose definition depends on new production instrumentation is
//     reported with an explicit `metricSource`. Where the pre-patch runtime has
//     no counter, the benchmark derives the value from behaviour that is
//     observable from outside the process instead of printing a guess.

import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"

export function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  return process.argv[index + 1] || fallback
}

export function hasFlag(name) {
  return process.argv.includes(name)
}

export async function withTempDir(label, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v153-" + label + "-"))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

export function round(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits))
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { ms: round(performance.now() - started), value }
}

export async function fileBytes(relative, root) {
  const info = await stat(path.join(root, ...relative.split("/"))).catch(() => null)
  return info?.isFile() ? info.size : 0
}

export async function sumBytes(relatives, root) {
  let total = 0
  for (const relative of relatives) total += await fileBytes(relative, root)
  return total
}

export async function dirBytes(dir) {
  const { readdir } = await import("node:fs/promises")
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirBytes(full)
    else if (entry.isFile()) total += (await stat(full).catch(() => null))?.size || 0
  }
  return total
}

export function printReceipt(receipt, pretty = hasFlag("--json")) {
  process.stdout.write(JSON.stringify(receipt, null, pretty ? 2 : 0) + "\n")
}

// Dynamic loader used for phases that do not exist yet.
//
// The benchmark must be runnable against the pre-patch tree (that is the whole
// point of a baseline) and against the post-patch tree with one identical
// command. A missing module is therefore reported as an explicit `unavailable`
// row rather than crashing the run, so a baseline receipt and an after receipt
// have the same shape.
export async function optionalModule(specifier) {
  try {
    return { ok: true, module: await import(specifier) }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
