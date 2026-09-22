function taskFiles(task = {}) {
  if (Array.isArray(task.files)) return task.files
  const files = task.files && typeof task.files === "object" ? task.files : {}
  return [...new Set(["create","modify","test","delete"].flatMap((key) => Array.isArray(files[key]) ? files[key] : []))]
}

function writes(task = {}) {
  const files = task.files && typeof task.files === "object" && !Array.isArray(task.files) ? task.files : null
  if (!files) return Array.isArray(task.files) && task.files.length > 0
  return ["create","modify","delete"].some((key) => Array.isArray(files[key]) && files[key].length > 0)
}

export function classifyWorkflowTask(task = {}) {
  const text = [task.title, task.summary, ...(task.acceptance || [])].filter(Boolean).join(" ").toLowerCase()
  const visual = /(visual|screenshot|pixel|figma|layout|giao diện|ảnh mẫu)/.test(text)
  const deterministic = task.deterministic === true || /(run test|typecheck|lint|format|generate manifest|build index|verify command)/.test(text)
  const kind = deterministic ? "deterministic" : visual ? "vision" : "llm"
  const fileCount = taskFiles(task).length
  const estimatedCost = kind === "deterministic" ? 1 : Math.max(2, Math.min(10, 2 + fileCount + (task.risk === "high" ? 3 : 0)))
  return { kind, estimatedCost, writes: writes(task), files: taskFiles(task) }
}

function conflict(a, b) {
  if (!a.writes && !b.writes) return false
  const aa = new Set(a.files)
  return b.files.some((file) => aa.has(file))
}

export function planDynamicWorkflow(tasks = [], options = {}) {
  const maxConcurrent = Math.max(1, Math.min(16, Number(options.maxConcurrent || 4)))
  const byID = new Map(tasks.map((task) => [task.id, task]))
  const remaining = new Set(tasks.map((task) => task.id))
  const complete = new Set()
  const waves = []
  let waveIndex = 0

  while (remaining.size) {
    const ready = [...remaining]
      .map((id) => byID.get(id))
      .filter((task) => (task.dependsOn || task.dependencies || []).every((dep) => complete.has(dep)))
      .sort((a, b) => classifyWorkflowTask(a).estimatedCost - classifyWorkflowTask(b).estimatedCost)

    if (!ready.length) throw new Error("Workflow contains a dependency cycle or missing dependency")

    const selected = []
    for (const task of ready) {
      if (selected.length >= maxConcurrent) break
      const classification = classifyWorkflowTask(task)
      if (selected.some((item) => conflict(classification, item.classification))) continue
      selected.push({ task, classification })
    }
    if (!selected.length) selected.push({ task: ready[0], classification: classifyWorkflowTask(ready[0]) })

    waves.push({
      index: waveIndex++,
      tasks: selected.map(({ task, classification }) => ({
        id: task.id,
        kind: classification.kind,
        estimatedCost: classification.estimatedCost,
        writes: classification.writes,
        files: classification.files,
        spawnAgent: classification.kind !== "deterministic",
      })),
      totalEstimatedCost: selected.reduce((sum, item) => sum + item.classification.estimatedCost, 0),
    })
    for (const { task } of selected) {
      remaining.delete(task.id)
      complete.add(task.id)
    }
  }

  return {
    schemaVersion: 1,
    maxConcurrent,
    waves,
    taskCount: tasks.length,
    agentTaskCount: waves.flatMap((wave) => wave.tasks).filter((task) => task.spawnAgent).length,
    deterministicTaskCount: waves.flatMap((wave) => wave.tasks).filter((task) => !task.spawnAgent).length,
  }
}
