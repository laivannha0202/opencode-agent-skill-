import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildRepoGraph } from "../lib/repo-graph.mjs"

test("repo graph resolves local imports and ranks incoming hotspots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-graph-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "core.js"), "export const core = 1\n")
    await writeFile(path.join(root, "src", "a.js"), "import { core } from './core.js'\nexport { core }\n")
    await writeFile(path.join(root, "src", "b.js"), "const { core } = require('./core.js')\nexport { core }\n")

    const graph = await buildRepoGraph(root, { ioConcurrency: 4 })
    assert.equal(graph.nodes.length, 3)
    assert.equal(graph.edges.length, 2)
    assert.equal(graph.hotspots[0].path, "src/core.js")
    assert.equal(graph.hotspots[0].incoming, 2)

    const serial = await buildRepoGraph(root, { ioConcurrency: 1 })
    assert.deepEqual(serial.nodes, graph.nodes)
    assert.deepEqual(serial.edges, graph.edges)
    assert.deepEqual(serial.hotspots, graph.hotspots)
    assert.deepEqual(serial.externalImports, graph.externalImports)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("repo graph ignores canonical UES runtime artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-graph-runtime-artifacts-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "real.js"), "export const realGraphSymbol = 1\n")
    for (const dir of [".ues-work", ".ues-learning", ".ues-dashboard", ".ues-sandboxes", ".ues-cache", ".ues-traces", ".ues-memory", ".ues-evals", ".ues-services"]) {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, "fake.js"), "export const fakeGraphSymbol = 1\n")
    }

    const graph = await buildRepoGraph(root, { maxFiles: 100, ioConcurrency: 4 })
    assert.deepEqual(graph.nodes.map((node) => node.path), ["src/real.js"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
