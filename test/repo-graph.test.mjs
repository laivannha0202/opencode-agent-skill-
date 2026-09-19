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

    const graph = await buildRepoGraph(root)
    assert.equal(graph.nodes.length, 3)
    assert.equal(graph.edges.length, 2)
    assert.equal(graph.hotspots[0].path, "src/core.js")
    assert.equal(graph.hotspots[0].incoming, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
