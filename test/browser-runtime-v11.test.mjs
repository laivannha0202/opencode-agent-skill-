import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspectBrowserPage, summarizeBrowserInspection } from "../lib/browser-runtime.mjs"

test("V11 browser inspection summary stays bounded and preserves untrusted evidence boundary", () => {
  const report = summarizeBrowserInspection({
    trustLevel: "untrusted-external",
    finalUrl: "https://example.com/",
    title: "Example",
    viewport: { width: 1440, height: 900 },
    screenshot: ".ues-cache/browser-v1/example.png",
    elements: Array.from({ length: 40 }, (_, index) => ({
      index,
      role: index === 0 ? "button" : "link",
      name: "element " + index,
      id: null,
      testId: null,
      box: { x: index, y: index, width: 100, height: 40 },
      visible: true,
    })),
  }, { limit: 12 })
  assert.equal(report.trustLevel, "untrusted-external")
  assert.equal(report.elementCount, 40)
  assert.equal(report.elements.length, 12)
  assert.equal(report.elements[0].role, "button")
})

test("V11 browser runtime rejects non-http schemes before invoking browser tooling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-browser-v11-"))
  try {
    await writeFile(path.join(root, "package.json"), "{}")
    await assert.rejects(
      () => inspectBrowserPage(root, "file:///etc/passwd"),
      /only allows http\(s\) URLs/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V11 browser runtime fails closed when project-local Playwright is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-browser-v11-"))
  try {
    await writeFile(path.join(root, "package.json"), "{}")
    await assert.rejects(
      () => inspectBrowserPage(root, "https://example.com/"),
      /Playwright is unavailable/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
