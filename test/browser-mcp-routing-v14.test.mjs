import assert from "node:assert/strict"
import test from "node:test"

import {
  browserEvidenceNeeded,
  selectBrowserMcpToolNames,
  visualEvidenceNeeded,
} from "../lib/browser-mcp-routing.mjs"

test("browser routing stays off for ordinary backend tasks", () => {
  assert.equal(
    browserEvidenceNeeded("Fix inventory transaction rollback in the NestJS service", "executor"),
    false,
  )
  assert.equal(
    visualEvidenceNeeded("Fix inventory transaction rollback in the NestJS service"),
    false,
  )
})

test("browser routing turns on for E2E and visual work", () => {
  assert.equal(
    browserEvidenceNeeded("Verify the checkout form flow in Playwright E2E", "verifier"),
    true,
  )
  assert.equal(
    browserEvidenceNeeded("Match this responsive UI screenshot", "executor"),
    true,
  )
  assert.equal(
    browserEvidenceNeeded("Verify the rendered result", "visual-verifier"),
    true,
  )
  assert.equal(visualEvidenceNeeded("Match this responsive UI screenshot"), true)
})

test("browser MCP selector keeps Playwright tools and excludes unrelated tools", () => {
  const tools = [
    { name: "read", description: "Read files" },
    { name: "github_get_file", description: "Read a GitHub file" },
    { name: "browser_navigate", description: "Navigate a browser page with Playwright" },
    { name: "browser_snapshot", description: "Capture accessibility snapshot with Playwright" },
    { name: "browser_screenshot", description: "Capture screenshot with Playwright" },
    { name: "browser_click", description: "Click an element with Playwright" },
    { name: "context7_query", description: "Query package documentation" },
  ]

  const selected = selectBrowserMcpToolNames(tools, { limit: 3 })

  assert.deepEqual(selected, [
    "browser_snapshot",
    "browser_screenshot",
    "browser_navigate",
  ])
  assert.equal(selected.includes("github_get_file"), false)
  assert.equal(selected.includes("context7_query"), false)
})

test("explicit browser tool names are honored only when actually available", () => {
  const tools = [
    { name: "custom_browser_open", description: "Open page" },
    { name: "browser_snapshot", description: "Browser snapshot" },
  ]

  const selected = selectBrowserMcpToolNames(tools, {
    explicitNames: ["custom_browser_open", "missing_browser_tool"],
    limit: 2,
  })

  assert.equal(selected[0], "custom_browser_open")
  assert.equal(selected.includes("missing_browser_tool"), false)
  assert.equal(selected.includes("browser_snapshot"), true)
})
