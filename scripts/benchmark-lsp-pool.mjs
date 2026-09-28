import { performance } from "node:perf_hooks"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  lspPoolStatus,
  resetLspPoolMetrics,
  shutdownLspPool,
  withManagedLspSession,
} from "../lib/code-intelligence/lsp-pool.mjs"

const MOCK_SERVER = `
let buffer = Buffer.alloc(0)
function encode(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii"), body])
}
function send(payload) { process.stdout.write(encode(payload)) }
function dispatch(message) {
  const method = String(message?.method || "")
  if (message?.id != null) {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { documentSymbolProvider: true } } })
      return
    }
    if (method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: message.id, result: [{ name: "benchSymbol", kind: 12, range: null, selectionRange: null }] })
      return
    }
    send({ jsonrpc: "2.0", id: message.id, result: null })
    return
  }
  if (method === "exit") process.exit(0)
}
function parse() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n")
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const match = header.match(/Content-Length:\\s*(\\d+)/i)
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString("utf8")
    buffer = buffer.subarray(start + length)
    try { dispatch(JSON.parse(body)) } catch {}
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  parse()
})
`

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-bench-"))
  try {
    resetLspPoolMetrics()
    const server = path.join(root, "mock-lsp.mjs")
    const source = path.join(root, "demo.ts")
    await writeFile(server, MOCK_SERVER, "utf8")
    await writeFile(source, "export const benchmarkValue = 1\n", "utf8")

    const provider = {
      id: "typescript-benchmark",
      command: process.execPath,
      args: [server],
      languageId: "typescript",
    }
    const target = { base: root, file: source, info: await stat(source) }
    const run = async () => {
      const started = performance.now()
      const result = await withManagedLspSession(
        target,
        provider,
        { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
        async (session) => session.request("textDocument/documentSymbol", {
          textDocument: { uri: session.uri },
        }),
      )
      if (!result.ok) throw new Error("LSP benchmark failed: " + String(result.reason || result.error || "unknown"))
      return {
        totalMs: performance.now() - started,
        poolHit: result.meta.poolHit,
        coldStartMs: result.meta.coldStartMs,
        operationDurationMs: result.meta.operationDurationMs,
      }
    }

    const cold = await run()
    const warm = []
    for (let index = 0; index < 8; index += 1) warm.push(await run())
    const warmTotals = warm.map((item) => item.totalMs)
    const status = lspPoolStatus()

    console.log(JSON.stringify({
      schemaVersion: 1,
      kind: "ues-lsp-pool-benchmark",
      node: process.version,
      platform: process.platform,
      cold: {
        totalMs: Number(cold.totalMs.toFixed(3)),
        coldStartMs: cold.coldStartMs,
        operationDurationMs: cold.operationDurationMs,
      },
      warm: {
        samples: warm.length,
        medianTotalMs: Number(median(warmTotals).toFixed(3)),
        minTotalMs: Number(Math.min(...warmTotals).toFixed(3)),
        maxTotalMs: Number(Math.max(...warmTotals).toFixed(3)),
        allPoolHits: warm.every((item) => item.poolHit === true),
      },
      pool: status.metrics,
    }, null, 2))
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
}

await main()
