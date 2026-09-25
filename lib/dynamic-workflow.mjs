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

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function classifyWorkflowTask(task = {}) {
  const text = [task.title, task.summary, ...(task.acceptance || [])].filter(Boolean).join(" ").toLowerCase()
  const visual = /(visual|screenshot|pixel|figma|layout|giao diện|ảnh mẫu|image reference)/.test(text)
  const deterministic = task.deterministic === true || /(run test|typecheck|lint|format|generate manifest|build index|verify command|compile|unit test)/.test(text)
  const kind = deterministic ? "deterministic" : visual ? "vision" : "llm"
  const fileCount = taskFiles(task).length
  const acceptanceCount = Array.isArray(task.acceptance) ? task.acceptance.length : 0
  const verificationCount = Array.isArray(task.verification) ? task.verification.length : 0
  const estimatedCost = kind === "deterministic"
    ? 1
    : Math.max(
        2,
        Math.min(
          12,
          2 + fileCount + Math.min(3, acceptanceCount) + Math.min(2, verificationCount) + (task.risk === "high" ? 3 : 0),
        ),
      )
  return {
    kind,
    estimatedCost,
    writes: writes(task),
    files: taskFiles(task),
    risk: task.risk || "medium",
  }
}

function conflict(a, b) {
  if (!a.writes && !b.writes) return false
  const aa = new Set(a.files)
  return b.files.some((file) => aa.has(file))
}

function executionMode(classification, options) {
  if (classification.kind === "deterministic") return "deterministic"
  if (options.allowInline === false) return "agent"
  if (classification.kind === "vision") {
    return classification.estimatedCost >= options.minVisionAgentCost ? "agent" : "inline"
  }
  return classification.estimatedCost >= options.minAgentCost ? "agent" : "inline"
}

function kindCapacity(selected, classification, options) {
  if (classification.kind === "vision") {
    return selected.filter((item) => item.classification.kind === "vision" && item.execution === "agent").length < options.maxVisionConcurrent
  }
  if (classification.kind === "llm") {
    return selected.filter((item) => item.classification.kind === "llm" && item.execution === "agent").length < options.maxLLMConcurrent
  }
  return true
}

function readyTasks(remaining, byID, complete) {
  return [...remaining]
    .map((id) => byID.get(id))
    .filter((task) => (task.dependsOn || task.dependencies || []).every((dep) => complete.has(dep)))
}

export function planDynamicWorkflow(tasks = [], inputOptions = {}) {
  const options = {
    maxConcurrent: clampInt(inputOptions.maxConcurrent, 4, 1, 16),
    maxLLMConcurrent: clampInt(inputOptions.maxLLMConcurrent, inputOptions.maxConcurrent || 4, 1, 16),
    maxVisionConcurrent: clampInt(inputOptions.maxVisionConcurrent, 2, 1, 8),
    maxWaveCost: clampInt(inputOptions.maxWaveCost, 24, 1, 128),
    minAgentCost: clampInt(inputOptions.minAgentCost, 5, 2, 12),
    minVisionAgentCost: clampInt(inputOptions.minVisionAgentCost, 4, 2, 12),
    deterministicFirst: inputOptions.deterministicFirst !== false,
    allowInline: inputOptions.allowInline !== false,
  }

  const byID = new Map(tasks.map((task) => [task.id, task]))
  if (byID.size !== tasks.length || tasks.some((task) => !task?.id)) {
    throw new Error("Workflow tasks require unique non-empty ids")
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn || task.dependencies || []) {
      if (!byID.has(dep)) throw new Error("Workflow contains a missing dependency: " + dep)
    }
  }

  const remaining = new Set(tasks.map((task) => task.id))
  const complete = new Set()
  const waves = []
  let waveIndex = 0

  while (remaining.size) {
    const ready = readyTasks(remaining, byID, complete)
    if (!ready.length) throw new Error("Workflow contains a dependency cycle or missing dependency")

    const deterministicReady = ready.filter((task) => classifyWorkflowTask(task).kind === "deterministic")
    const candidates = options.deterministicFirst && deterministicReady.length
      ? deterministicReady
      : ready

    const classified = candidates
      .map((task) => {
        const classification = classifyWorkflowTask(task)
        return { task, classification, execution: executionMode(classification, options) }
      })
      .sort((a, b) => {
        const order = { deterministic: 0, inline: 1, agent: 2 }
        return order[a.execution] - order[b.execution] ||
          a.classification.estimatedCost - b.classification.estimatedCost ||
          a.task.id.localeCompare(b.task.id)
      })

    const selected = []
    let waveCost = 0
    for (const item of classified) {
      if (selected.length >= options.maxConcurrent) break
      if (selected.some((existing) => conflict(item.classification, existing.classification))) continue
      if (!kindCapacity(selected, item.classification, options)) continue
      if (selected.length && waveCost + item.classification.estimatedCost > options.maxWaveCost) continue
      selected.push(item)
      waveCost += item.classification.estimatedCost
    }

    if (!selected.length) selected.push(classified[0])

    const tasksInWave = selected.map(({ task, classification, execution }) => ({
      id: task.id,
      kind: classification.kind,
      execution,
      estimatedCost: classification.estimatedCost,
      writes: classification.writes,
      files: classification.files,
      spawnAgent: execution === "agent",
      rationale:
        execution === "deterministic"
          ? "deterministic tool/script work should not consume an agent slot"
          : execution === "inline"
            ? "coordination cost exceeds expected benefit for this bounded unit"
            : classification.kind === "vision"
              ? "visual judgment requires a bounded vision worker"
              : "independent task size justifies isolated agent execution",
    }))

    waves.push({
      index: waveIndex++,
      tasks: tasksInWave,
      totalEstimatedCost: tasksInWave.reduce((sum, item) => sum + item.estimatedCost, 0),
      agentSlots: tasksInWave.filter((item) => item.spawnAgent).length,
      visionAgentSlots: tasksInWave.filter((item) => item.spawnAgent && item.kind === "vision").length,
    })

    for (const { task } of selected) {
      remaining.delete(task.id)
      complete.add(task.id)
    }
  }

  const flat = waves.flatMap((wave) => wave.tasks)
  return {
    schemaVersion: 2,
    options,
    waves,
    taskCount: tasks.length,
    agentTaskCount: flat.filter((task) => task.spawnAgent).length,
    inlineTaskCount: flat.filter((task) => task.execution === "inline").length,
    deterministicTaskCount: flat.filter((task) => task.execution === "deterministic").length,
    visionAgentTaskCount: flat.filter((task) => task.spawnAgent && task.kind === "vision").length,
    estimatedCoordinationSaved: flat.filter((task) => task.execution !== "agent").reduce((sum, task) => sum + task.estimatedCost, 0),
  }
}