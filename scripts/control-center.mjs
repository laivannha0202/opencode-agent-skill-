#!/usr/bin/env node
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { writeControlCenter } from "../lib/control-center.mjs"

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
    if (req.url === "/data.json") {
      const body = await readFile(path.join(result.dir, "data.json"))
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
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
