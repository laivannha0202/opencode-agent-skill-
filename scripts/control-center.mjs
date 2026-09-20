#!/usr/bin/env node
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { collectControlCenterData, writeControlCenter } from "../lib/control-center.mjs"
import { recoverStaleTasks } from "../lib/task-engine.mjs"

const args = process.argv.slice(2)
const root = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : process.cwd())
const outputIndex = args.indexOf("--output")
const output = outputIndex >= 0 ? args[outputIndex + 1] : null
const portIndex = args.indexOf("--port")
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] || "4177", 10) : 4177
const serve = args.includes("--serve")

const result = await writeControlCenter(root, output)
console.log("[ues] Control Center: " + result.file)

if (serve) {
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/recover") {
      let body = ""
      for await (const chunk of req) {
        body += chunk
        if (body.length > 16 * 1024) {
          res.writeHead(413)
          res.end("request too large")
          return
        }
      }
      try {
        const input = JSON.parse(body || "{}")
        const result = await recoverStaleTasks(root, String(input.slug || ""))
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        res.end(JSON.stringify(result, null, 2) + "\n")
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        res.end(String(error?.message || error))
      }
      return
    }
    if (req.url === "/data.json") {
      const current = await collectControlCenterData(root)
      const body = JSON.stringify(current, null, 2) + "\n"
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      res.end(body)
      return
    }
    const body = await readFile(result.file)
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(body)
  })
  server.listen(port, "127.0.0.1", () => {
    console.log("[ues] Serving http://127.0.0.1:" + port)
  })
}
