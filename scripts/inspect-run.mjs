#!/usr/bin/env node
import process from "node:process"
import {
  compareRunInspections,
  inspectRun,
  listRunJournals,
} from "../lib/run-inspector.mjs"

function hasArg(name) {
  return process.argv.slice(2).includes(name)
}

function argValue(name) {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function positional() {
  const args = process.argv.slice(2)
  const rows = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      if (["--compare", "--root"].includes(args[index])) index += 1
      continue
    }
    rows.push(args[index])
  }
  return rows
}

const root = argValue("--root") || process.cwd()
const values = positional()
let runId = values[0] || "last"
const recent = await listRunJournals(root, { limit: 50 })
if (runId === "last") runId = recent[0]?.runId || ""
if (!runId) {
  console.error("No UES run journal found.")
  process.exit(2)
}

const inspected = await inspectRun(root, runId)
const compareArg = argValue("--compare")
let payload = inspected
if (compareArg) {
  let otherId = compareArg
  if (otherId === "previous") {
    const currentIndex = recent.findIndex((row) => row.runId === runId)
    otherId = recent[currentIndex + 1]?.runId || ""
  }
  if (!otherId) {
    console.error("No comparison UES run journal found.")
    process.exit(2)
  }
  const other = await inspectRun(root, otherId)
  payload = {
    schemaVersion: 1,
    current: inspected,
    comparisonBase: other,
    comparison: compareRunInspections(other, inspected),
  }
}

if (hasArg("--json")) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  const current = payload.current || payload
  console.log("UES run inspector")
  console.log("run: " + current.runId)
  console.log("events: " + Number(current.summary?.events || 0))
  console.log("terminal: " + String(current.summary?.terminalType || "open"))
  console.log("tool queue total/max ms: " + Number(current.totalToolQueueMs || 0) + "/" + Number(current.maxToolQueueMs || 0))
  console.log("duplicate tool signatures: " + Number(current.duplicateToolSignatures?.length || 0))
  console.log("repeated read/search/mutation signatures: " +
    Number(current.repeatedReadSignatures?.length || 0) + "/" +
    Number(current.repeatedSearchSignatures?.length || 0) + "/" +
    Number(current.repeatedMutationSignatures?.length || 0))
  console.log("blocked/interrupted/failed tools: " +
    Number(current.blockedTools || 0) + "/" +
    Number(current.interruptedTools || 0) + "/" +
    Number(current.failedTools || 0))
  console.log("hidden-output verification pipelines: " + Number(current.hiddenOutputPipelines || 0))
  console.log("dangling tool calls: " + Number(current.summary?.danglingToolCalls?.length || 0))
  console.log("artifacts: " + (current.artifacts || []).join(", "))
  if (payload.comparison) {
    console.log("comparison: " + JSON.stringify(payload.comparison.deltas))
  }
}
