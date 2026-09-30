import { appendFileSync } from "node:fs"

if (process.env.UES_MOCK_LSP_COUNTER_FILE) {
  appendFileSync(process.env.UES_MOCK_LSP_COUNTER_FILE, "start\n", "utf8")
}

if (process.env.UES_MOCK_LSP_FAIL_ONCE_FILE) {
  const { existsSync, writeFileSync } = await import("node:fs")
  if (!existsSync(process.env.UES_MOCK_LSP_FAIL_ONCE_FILE)) {
    writeFileSync(process.env.UES_MOCK_LSP_FAIL_ONCE_FILE, "failed-once\n", "utf8")
    process.exit(17)
  }
}

let buffer = Buffer.alloc(0)
const documents = new Map()

function encode(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body])
}

function send(payload) {
  process.stdout.write(encode(payload))
}

function diagnostics(uri, version, text) {
  // A silent server models a real failure mode (analysis never publishes) so
  // callers can prove a notification timeout never tears down the session.
  if (process.env.UES_MOCK_LSP_SILENT === "1") return
  // A delayed server models the second real failure mode: analysis is slower
  // than the initial budget but lands inside the continuation window.
  const delayMs = Math.max(0, Number(process.env.UES_MOCK_LSP_DIAGNOSTICS_DELAY_MS || 5))
  setTimeout(() => {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version,
        diagnostics: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 2,
          source: "ues-mock-lsp",
          message: "mock-version-" + version + ":" + String(text || "").slice(0, 20),
        }],
      },
    })
  }, delayMs)
}

function documentItem(uri) {
  return {
    name: "mockSymbol",
    kind: 12,
    uri,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 8 },
    },
    selectionRange: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 8 },
    },
  }
}

function dispatch(message) {
  const method = String(message?.method || "")
  if (process.env.UES_MOCK_LSP_PROTOCOL_FILE && (method === "shutdown" || method === "exit")) {
    appendFileSync(process.env.UES_MOCK_LSP_PROTOCOL_FILE, method + "\n", "utf8")
  }
  if (message?.id != null) {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            documentSymbolProvider: true,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            callHierarchyProvider: true,
          },
        },
      })
      return
    }

    const uri = message?.params?.textDocument?.uri || message?.params?.item?.uri || ""
    if (method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: message.id, result: [documentItem(uri)] })
      return
    }
    if (method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "mock hover" } } })
      return
    }
    if (method === "textDocument/definition" || method === "textDocument/references") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 8 },
          },
        }],
      })
      return
    }
    if (method === "textDocument/prepareRename") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 8 },
        },
      })
      return
    }
    if (method === "textDocument/rename") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          changes: {
            [uri]: [{
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 8 },
              },
              newText: String(message?.params?.newName || ""),
            }],
          },
        },
      })
      return
    }
    if (method === "textDocument/prepareCallHierarchy") {
      send({ jsonrpc: "2.0", id: message.id, result: [documentItem(uri)] })
      return
    }
    if (method === "callHierarchy/incomingCalls" || method === "callHierarchy/outgoingCalls") {
      send({ jsonrpc: "2.0", id: message.id, result: [] })
      return
    }
    if (method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null })
      return
    }
    send({ jsonrpc: "2.0", id: message.id, result: null })
    return
  }

  if (method === "textDocument/didOpen") {
    const doc = message.params?.textDocument || {}
    documents.set(doc.uri, { text: doc.text || "", version: Number(doc.version || 1) })
    diagnostics(doc.uri, Number(doc.version || 1), doc.text || "")
    return
  }

  if (method === "textDocument/didChange") {
    const doc = message.params?.textDocument || {}
    const text = message.params?.contentChanges?.[0]?.text || ""
    documents.set(doc.uri, { text, version: Number(doc.version || 1) })
    diagnostics(doc.uri, Number(doc.version || 1), text)
    return
  }

  if (method === "exit") process.exit(0)
}

function parse() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + length) return
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
    buffer = buffer.subarray(bodyStart + length)
    try { dispatch(JSON.parse(body)) } catch {}
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  parse()
})
