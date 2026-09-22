function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "")
}

function declaredTaskFiles(task = {}) {
  const files = task.files
  const values = []
  if (Array.isArray(files)) values.push(...files)
  else if (files && typeof files === "object") {
    for (const list of Object.values(files)) {
      if (Array.isArray(list)) values.push(...list)
      else if (typeof list === "string") values.push(list)
    }
  }
  if (Array.isArray(task.requiredFiles)) values.push(...task.requiredFiles)
  return [...new Set(values.map(normalizePath).filter(Boolean))]
}

function manifestPaths(manifest = {}) {
  const values = []
  for (const item of manifest.excerpts || []) if (item?.path) values.push(item.path)
  for (const item of manifest.rankedReferences || []) if (item?.path) values.push(item.path)
  for (const item of manifest.instructions || []) {
    if (typeof item === "string") values.push(item)
    else if (item?.path) values.push(item.path)
  }
  return [...new Set(values.map(normalizePath).filter(Boolean))]
}

export function measureContextQuality(task = {}, manifest = {}, options = {}) {
  const required = declaredTaskFiles(task)
  const included = manifestPaths(manifest)
  const includedSet = new Set(included)
  const hits = required.filter((file) => includedSet.has(file))
  const requiredFileRecall = required.length ? hits.length / required.length : null
  const relevant = new Set(required)
  for (const item of manifest.excerpts || []) {
    if (["declared", "test", "instruction"].includes(item?.role) && item?.path) relevant.add(normalizePath(item.path))
  }
  const irrelevant = included.filter((file) => !relevant.has(file))
  const irrelevantRatio = included.length ? irrelevant.length / included.length : 0
  const minRequiredRecall = Number.isFinite(Number(options.minRequiredRecall))
    ? Math.max(0, Math.min(1, Number(options.minRequiredRecall))) : 1
  return {
    schemaVersion: 1,
    requiredFiles: required,
    includedFiles: included,
    requiredFileHits: hits,
    requiredFileRecall,
    irrelevantFiles: irrelevant,
    irrelevantRatio,
    checks: { requiredRecallAcceptable: requiredFileRecall == null ? true : requiredFileRecall >= minRequiredRecall },
  }
}
