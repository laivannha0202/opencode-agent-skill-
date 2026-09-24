function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/")
}

function normalizeSeeds(nodes, semanticResults = [], declared = [], changed = []) {
  const raw = new Map(nodes.map((node) => [node, 0]))
  const semanticMax = Math.max(1, ...semanticResults.map((item) => Number(item.score || 0)))
  for (const item of semanticResults) {
    const file = normalizePath(item.path)
    if (!raw.has(file)) continue
    raw.set(file, raw.get(file) + Number(item.score || 0) / semanticMax)
  }
  for (const file of declared.map(normalizePath)) {
    if (raw.has(file)) raw.set(file, raw.get(file) + 1.25)
  }
  for (const file of changed.map(normalizePath)) {
    if (raw.has(file)) raw.set(file, raw.get(file) + 0.75)
  }

  let total = [...raw.values()].reduce((sum, value) => sum + value, 0)
  if (total <= 0) {
    const uniform = nodes.length ? 1 / nodes.length : 0
    return new Map(nodes.map((node) => [node, uniform]))
  }
  return new Map([...raw.entries()].map(([key, value]) => [key, value / total]))
}

export function rankContextGraph(graph = {}, options = {}) {
  const nodes = [...new Set((graph.nodes || []).map((node) => normalizePath(node.path)).filter(Boolean))]
  if (!nodes.length) return []

  const nodeSet = new Set(nodes)
  const neighbors = new Map(nodes.map((node) => [node, new Map()]))
  const addEdge = (from, to, weight) => {
    if (!nodeSet.has(from) || !nodeSet.has(to) || from === to) return
    const row = neighbors.get(from)
    row.set(to, Number(row.get(to) || 0) + weight)
  }

  for (const edge of graph.edges || []) {
    const from = normalizePath(edge.from)
    const to = normalizePath(edge.to)
    // Imports carry relevance in both directions: the dependency is relevant to
    // its caller, while callers are useful when a dependency itself is seeded.
    addEdge(from, to, 1)
    addEdge(to, from, 0.55)
  }

  const seeds = normalizeSeeds(
    nodes,
    options.semanticResults || [],
    options.declared || [],
    options.changed || [],
  )
  const damping = Math.max(0.5, Math.min(0.95, Number(options.damping || 0.85)))
  const iterations = Math.max(4, Math.min(40, Number(options.iterations || 14)))
  let scores = new Map(seeds)

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map(nodes.map((node) => [node, (1 - damping) * Number(seeds.get(node) || 0)]))
    let dangling = 0

    for (const node of nodes) {
      const score = Number(scores.get(node) || 0)
      const row = neighbors.get(node)
      const totalWeight = [...row.values()].reduce((sum, weight) => sum + weight, 0)
      if (totalWeight <= 0) {
        dangling += score
        continue
      }
      for (const [target, weight] of row) {
        next.set(target, Number(next.get(target) || 0) + damping * score * (weight / totalWeight))
      }
    }

    if (dangling > 0) {
      for (const node of nodes) {
        next.set(
          node,
          Number(next.get(node) || 0) + damping * dangling * Number(seeds.get(node) || 0),
        )
      }
    }
    scores = next
  }

  const semantic = new Map(
    (options.semanticResults || []).map((item) => [normalizePath(item.path), Number(item.score || 0)]),
  )
  const maxRank = Math.max(1e-12, ...scores.values())
  const maxSemantic = Math.max(1, ...semantic.values())

  return nodes
    .map((file) => {
      const pageRank = Number(scores.get(file) || 0)
      const seed = Number(seeds.get(file) || 0)
      const semanticScore = Number(semantic.get(file) || 0)
      const normalizedRank = pageRank / maxRank
      const normalizedSemantic = semanticScore / maxSemantic
      const score = normalizedRank * 60 + normalizedSemantic * 40
      return {
        path: file,
        score: Number(score.toFixed(6)),
        pageRank: Number(pageRank.toFixed(10)),
        personalization: Number(seed.toFixed(10)),
        semanticScore,
        reasons: [
          semanticScore > 0 ? "semantic-seed" : null,
          (options.declared || []).map(normalizePath).includes(file) ? "declared" : null,
          (options.changed || []).map(normalizePath).includes(file) ? "changed" : null,
          Number(neighbors.get(file)?.size || 0) > 0 ? "dependency-graph" : null,
        ].filter(Boolean),
      }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(100, Number(options.limit || 32))))
}
