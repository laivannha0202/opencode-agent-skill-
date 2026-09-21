import { Plugin } from "@opencode/plugin"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { classifyIntent, routeSkills } from "./router.js"
import { destructiveShellRisk } from "./safety.js"
import { runtimeCapabilities } from "./capabilities.js"

const CONFIG_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".ues",
  "router.json",
)

function routerConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return {
      enabled: parsed.enabled !== false,
      maxSkills: Number.isInteger(parsed.maxSkills) ? Math.max(1, Math.min(parsed.maxSkills, 6)) : 4,
    }
  } catch {
    return { enabled: true, maxSkills: 4 }
  }
}


function findWindowsCommand(name) {
  const result = spawnSync("where", [name], { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout) return null
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return matches.find((item) => /\.(cmd|bat)$/i.test(item)) || matches[0] || null
}

function findNodeShimEntry(cmdPath) {
  const dir = path.dirname(cmdPath)
  let shim = ""
  try { shim = readFileSync(cmdPath, "utf8") } catch {}
  const match = shim.match(/node_modules[\\/][^\s"]+?\.(?:js|mjs)/gi)?.at(-1)
  if (!match) return null
  const entry = path.resolve(dir, match)
  return existsSync(entry) ? entry : null
}

function runOcskill(args, cwd) {
  const common = {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }
  let result
  if (process.platform !== "win32") {
    result = spawnSync("ocskill", args, common)
  } else {
    const resolved = findWindowsCommand("ocskill")
    if (!resolved) throw new Error("ocskill command was not found on PATH")
    if (/\.(cmd|bat)$/i.test(resolved)) {
      const entry = findNodeShimEntry(resolved)
      if (!entry) throw new Error("refusing to execute an unrecognized ocskill batch shim through cmd.exe")
      result = spawnSync(process.execPath, [entry, ...args], common)
    } else {
      result = spawnSync(resolved, args, common)
    }
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "ocskill command failed").trim())
  }
  return (result.stdout || "").trim()
}

function runOcskillJSON(args, cwd) {
  const output = runOcskill(args, cwd)
  try {
    return JSON.parse(output)
  } catch {
    throw new Error("ocskill returned invalid JSON for: " + args.join(" "))
  }
}

function appendTrace(traceID, type, payload, cwd) {
  try {
    const encoded = Buffer.from(JSON.stringify(payload || {}), "utf8").toString("base64")
    runOcskill(["trace", "append", traceID, cwd, "--type", type, "--payload-b64", encoded], cwd)
  } catch {}
}

function modelRef(value) {
  if (!value || typeof value !== "string") return null
  const [base, variant] = value.split("#", 2)
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return null
  return {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(variant ? { variant } : {}),
  }
}

function messageExcerpt(messages) {
  const value = Array.isArray(messages) ? messages.slice(-6) : messages
  const text = JSON.stringify(value)
  return text.length <= 24000 ? text : text.slice(-24000)
}

function taskHasWrites(task) {
  const files = task?.files
  if (Array.isArray(files)) return files.length > 0
  if (!files || typeof files !== "object") return false
  return ["create", "modify", "test", "delete"].some(
    (key) => Array.isArray(files[key]) && files[key].length > 0,
  )
}

function policySkills(policy) {
  const selected = []
  const add = (id) => { if (id && !selected.includes(id)) selected.push(id) }
  if (policy?.mode === "long-horizon") {
    add("ues-engineering-orchestrator")
    add("ues-long-task-state")
    add("ues-task-planner")
  } else if (policy?.mode === "standard" || policy?.risk === "high") {
    add("ues-engineering-orchestrator")
  }
  const map = {
    "auth-security": "ues-auth-security",
    payment: "ues-payment-engineering",
    database: "ues-database-engineering",
    "api-contract": "ues-api-contract",
    "react-native": "ues-react-native-engineering",
    nextjs: "ues-nextjs-engineering",
    react: "ues-react-engineering",
    devops: "ues-devops-engineering",
  }
  for (const domain of policy?.domains || []) add(map[domain])
  if (policy?.risk === "high") add("ues-change-impact-analysis")
  return selected
}

function projectRoutingFacts(projectRoot) {
  let inspected = null
  let learning = null
  try { inspected = runOcskillJSON(["inspect", projectRoot], projectRoot) } catch {}
  try { learning = runOcskillJSON(["learn", "status", projectRoot], projectRoot) } catch {}

  const feedbackDomains = []
  for (const item of learning?.accepted || []) {
    if (item.status !== "promoted") continue
    const learned = classifyIntent(item.candidateRule || item.recommendation || item.title || "")
    for (const domain of learned.domains || []) {
      if (!feedbackDomains.includes(domain)) feedbackDomains.push(domain)
    }
  }

  return {
    repoStacks: inspected?.stack?.stacks || [],
    feedbackDomains,
    acceptedLearningCount: (learning?.accepted || []).filter((item) => item.status === "promoted").length,
  }
}

export default Plugin.define({
  id: "ues-router",
  async setup(ctx) {
    const projectRoot = ctx.location.project?.canonical || ctx.location.directory
    const capabilities = runtimeCapabilities(ctx)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ues",
        description: "UES long-horizon state, deterministic planning evidence, and fresh-context task execution.",
      })
      editor.add({
        name: "capabilities",
        description: "Report detected OpenCode runtime capabilities used by UES instead of assuming behavior from a version number.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async () => ({ content: JSON.stringify(capabilities, null, 2) }),
      })
      editor.add({
        name: "task_policy",
        description: "Classify an engineering request into inline, standard or long-horizon mode with risk/model/context guidance.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["task-policy", input.text], projectRoot),
        }),
      })
      editor.add({
        name: "semantic_search",
        description: "Search the persistent incremental semantic index. Returns bounded path/symbol/reference evidence; never treats lexical evidence as semantic proof.",
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["aci", "search", input.query, projectRoot, "--limit", String(input.limit || 20)], projectRoot),
        }),
      })
      editor.add({
        name: "references",
        description: "Find bounded syntax-aware lexical references and concrete definition lines for one identifier.",
        input: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["symbol"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["aci", "refs", input.symbol, projectRoot, "--limit", String(input.limit || 40)], projectRoot),
        }),
      })
      editor.add({
        name: "view_file",
        description: "Read a bounded line-numbered window from a repository file; refuses root escapes and oversized/binary files.",
        input: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "integer", minimum: 1 },
            lines: { type: "integer", minimum: 1, maximum: 240 },
          },
          required: ["file"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill([
            "aci", "view", input.file, projectRoot,
            "--line", String(input.line || 1),
            "--lines", String(input.lines || 120),
          ], projectRoot),
        }),
      })
      editor.add({
        name: "sandbox_capability",
        description: "Report whether fail-closed Docker/Podman verification isolation is actually available. Never assumes a container runtime exists.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async () => ({
          content: runOcskill(["sandbox", "capability"], projectRoot),
        }),
      })
      editor.add({
        name: "work_status",
        description: "Read durable status for a UES .ues-work item without modifying it.",
        input: {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["work", "status", input.slug, projectRoot], projectRoot),
        }),
      })
      editor.add({
        name: "task_graph",
        description: "Validate a UES PLAN.json and compute dependency-safe execution waves.",
        input: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["task-graph", input.plan], projectRoot),
        }),
      })
      editor.add({
        name: "context_pack",
        description: "Read the bounded durable context pack for one UES task executor.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string" },
            task: { type: "string" },
          },
          required: ["slug", "task"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => ({
          content: runOcskill(["context-pack", input.slug, input.task, projectRoot], projectRoot),
        }),
      })
      editor.add({
        name: "recover_task",
        description: "Safely recover one stale UES task attempt. If an attached executor session still exists, interrupt it before releasing the durable lease.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string" },
            task: { type: "string" },
            force: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["slug", "task"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => {
          const status = runOcskillJSON(["work", "status", input.slug, projectRoot], projectRoot)
          const running = (status.running || []).find((item) => item.taskID === input.task)
          if (!running) throw new Error("task is not currently running: " + input.task)

          let interrupted = false
          if (running.sessionID && capabilities.sessionInterrupt) {
            try {
              await ctx.session.interrupt({ sessionID: running.sessionID, continue: false })
              interrupted = true
            } catch {}
          }

          const recoverArgs = ["work", "recover-task", input.slug, input.task, projectRoot]
          if (input.force) recoverArgs.push("--force")
          if (input.reason) recoverArgs.push("--reason", input.reason)
          const recovered = runOcskillJSON(recoverArgs, projectRoot)
          return {
            content: JSON.stringify({
              interrupted,
              sessionID: running.sessionID || null,
              recovered,
            }, null, 2),
          }
        },
      })
      editor.add({
        name: "cancel_task",
        description: "Interrupt a running UES executor session and mark its durable task attempt failed.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string" },
            task: { type: "string" },
            reason: { type: "string" },
          },
          required: ["slug", "task"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input) => {
          if (!capabilities.sessionInterrupt) {
            throw new Error("OpenCode runtime does not expose session.interrupt")
          }
          const status = runOcskillJSON(["work", "status", input.slug, projectRoot], projectRoot)
          const running = (status.running || []).find((item) => item.taskID === input.task)
          if (!running) throw new Error("task is not currently running: " + input.task)
          if (!running.sessionID) throw new Error("running task has no attached executor session")
          await ctx.session.interrupt({ sessionID: running.sessionID, continue: false })
          const failArgs = [
            "work", "fail", input.slug, input.task, projectRoot,
            "--reason", input.reason || "cancelled by user/runtime",
          ]
          if (running.runId) failArgs.push("--run-id", running.runId)
          const failed = runOcskillJSON(failArgs, projectRoot)
          return {
            content: JSON.stringify({
              interrupted: true,
              sessionID: running.sessionID,
              task: input.task,
              state: failed,
            }, null, 2),
          }
        },
      })
      editor.add({
        name: "dispatch_task",
        description: "Start one approved UES task and execute it in a fresh ues-executor session with bounded runtime and interrupt-on-timeout. The parent must inspect the diff and record completion evidence separately.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string" },
            task: { type: "string" },
            timeoutMs: { type: "integer", minimum: 30000, maximum: 3600000 },
            isolate: { type: "boolean" },
            integrate: { type: "boolean" },
          },
          required: ["slug", "task"],
          additionalProperties: false,
        },
        options: { namespace: "ues", codemode: true },
        execute: async (input, tool) => {
          if (!capabilities.freshDispatch) {
            throw new Error("OpenCode runtime does not expose the fresh-session capabilities required by ues.dispatch_task")
          }
          await tool.progress({ status: "starting fresh UES executor" })
          const started = runOcskillJSON(["work", "start", input.slug, input.task, projectRoot], projectRoot)
          const attempt = started?.record?.attempts || 1
          const runId = started?.record?.runId || null
          const traceID = "dispatch-" + input.slug + "-" + input.task + "-" + String(runId || Date.now()).replace(/[^a-zA-Z0-9._-]+/g, "-")
          const taskText = [
            started?.contextPack?.task?.title,
            started?.contextPack?.task?.summary,
            ...(started?.contextPack?.task?.acceptance || []),
            started?.contextPack?.task?.risk ? "risk: " + started.contextPack.task.risk : null,
          ].filter(Boolean).join(" ")
          const taskPolicy = runOcskillJSON(["task-policy", taskText], projectRoot)
          appendTrace(traceID, "dispatch.started", {
            slug: input.slug,
            task: input.task,
            runId,
            attempt,
            taskText,
            taskPolicy,
            context: {
              files: started?.contextPack?.contextManifest?.files || [],
              strategy: started?.contextPack?.contextManifest?.strategy || null,
              used: started?.contextPack?.contextManifest?.used || 0,
              budget: started?.contextPack?.contextManifest?.budget || 0,
            },
          }, projectRoot)
          const timeoutMs = Math.max(
            30_000,
            Math.min(Number(input.timeoutMs || (taskPolicy.mode === "long-horizon" ? 20 * 60_000 : 10 * 60_000)), 60 * 60_000),
          )
          const policyArgs = ["model-policy", "executor", "--attempt", String(attempt)]
          if (taskText) policyArgs.push("--text", taskText)
          const policy = runOcskillJSON(policyArgs, projectRoot)
          const workStatus = runOcskillJSON(["work", "status", input.slug, projectRoot], projectRoot)
          const workingTree = runOcskillJSON(["working-tree", projectRoot], projectRoot)
          const rootClean = workingTree?.git === true && workingTree?.clean === true
          const writerTask = taskHasWrites(started?.contextPack?.task)
          if (input.isolate === true && !rootClean) {
            throw new Error("explicit sandbox isolation requires a clean root working tree; commit/stash or integrate existing changes first")
          }
          if (input.isolate !== false && writerTask && !rootClean) {
            throw new Error("writer dispatch requires a clean root for automatic worktree isolation; clean the root or explicitly pass isolate:false to accept shared-root writes")
          }
          const autoIsolate =
            input.isolate === true ||
            (input.isolate !== false && rootClean && writerTask)
          let sandbox = null
          let executionDir = projectRoot
          if (autoIsolate) {
            sandbox = runOcskillJSON(
              ["sandbox", "create", input.slug, input.task, projectRoot],
              projectRoot,
            )
            executionDir = sandbox.dir
          }
          const heartbeatStarted = Date.now()
          const heartbeat = setInterval(() => {
            try {
              const args = ["work", "heartbeat", input.slug, input.task, projectRoot]
              if (runId) args.push("--run-id", runId)
              runOcskill(args, projectRoot)
              void tool.progress({ status: "executor running " + Math.round((Date.now() - heartbeatStarted) / 1000) + "s" })
            } catch {}
          }, 30_000)

          try {
            const created = await ctx.session.create({
              title: "UES " + input.slug + " " + input.task,
              location: { directory: executionDir },
            })
            appendTrace(traceID, "dispatch.session-created", {
              sessionID: created.id,
              executionDir,
              isolated: executionDir !== projectRoot,
            }, projectRoot)
            {
              const attachArgs = [
                "work", "attach-session", input.slug, input.task, projectRoot,
                "--session-id", created.id,
              ]
              if (runId) attachArgs.push("--run-id", runId)
              attachArgs.push("--execution-dir", executionDir)
              if (sandbox?.dir) attachArgs.push("--sandbox-dir", sandbox.dir)
              runOcskill(attachArgs, projectRoot)
            }
            await ctx.session.switchAgent({ sessionID: created.id, agent: "ues-executor" })
            const selectedModel = modelRef(policy?.model)
            if (selectedModel) {
              await ctx.session.switchModel({ sessionID: created.id, model: selectedModel })
            }

            await ctx.session.prompt({
              sessionID: created.id,
              text:
                "Implement exactly this approved UES task in the current repository. " +
                "Do not broaden scope or launch child agents. Run the declared verification and return the executor report.\n\n" +
                JSON.stringify(started.contextPack, null, 2),
            })

            let timer = null
            try {
              await Promise.race([
                ctx.session.wait({ sessionID: created.id }),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("UES executor timed out after " + timeoutMs + "ms")),
                    timeoutMs,
                  )
                }),
              ])
            } catch (error) {
              try {
                await ctx.session.interrupt({ sessionID: created.id, continue: false })
              } catch {}
              throw error
            } finally {
              if (timer) clearTimeout(timer)
            }

            const afterWait = runOcskillJSON(["work", "status", input.slug, projectRoot], projectRoot)
            const activeAttempt = (afterWait.running || []).find(
              (item) => item.taskID === input.task && (!runId || item.runId === runId),
            )
            if (!activeAttempt) {
              throw new Error("UES executor attempt is no longer active; refusing post-cancel integration or completion handoff")
            }

            const messages = await ctx.session.context({ sessionID: created.id })
            appendTrace(traceID, "dispatch.completed", {
              sessionID: created.id,
              task: input.task,
              runId,
              messageCount: Array.isArray(messages) ? messages.length : null,
            }, projectRoot)
            let integration = null
            if (sandbox && input.integrate === true) {
              integration = runOcskillJSON(
                ["sandbox", "integrate", sandbox.dir, projectRoot],
                projectRoot,
              )
              sandbox = null
            }
            return {
              content: JSON.stringify({
                sessionID: created.id,
                task: input.task,
                attempt,
                runId,
                traceID,
                taskPolicy,
                model: policy,
                timeoutMs,
                executionDir,
                isolated: executionDir !== projectRoot,
                sandbox,
                integration,
                messages: messageExcerpt(messages),
                next: sandbox
                  ? "Inspect and verify the isolated worktree first. If accepted, integrate it with ocskill sandbox integrate <worktree> . before recording work complete."
                  : "Inspect the child diff and verification, then call ocskill work complete or fail.",
              }, null, 2),
            }
          } catch (error) {
            appendTrace(traceID, "dispatch.failed", {
              task: input.task,
              runId,
              error: String(error?.message || error),
            }, projectRoot)
            if (sandbox?.dir) {
              try {
                runOcskill(["sandbox", "remove", sandbox.dir, projectRoot, "--force", "--delete-branch"], projectRoot)
              } catch {}
            }
            try {
              const failArgs = [
                "work", "fail", input.slug, input.task, projectRoot,
                "--reason", "fresh executor failed: " + String(error?.message || error),
              ]
              if (runId) failArgs.push("--run-id", runId)
              runOcskill(failArgs, projectRoot)
            } catch {}
            throw error
          } finally {
            clearInterval(heartbeat)
          }
        },
      })
    })

    const routingFacts = projectRoutingFacts(projectRoot)

    if (capabilities.sessionHook) {
      await ctx.session.hook("context", (event) => {
      if (event.agent === "title" || event.agent === "summary" || event.agent === "compaction") return
      event.system.push({
        type: "text",
        text: "UES runtime: choose FAST/STANDARD/DEEP from deterministic task policy, prefer bounded semantic/ACI evidence over broad scans, trust durable .ues-work state and EVENTS.jsonl over conversation memory, never treat lexical matches as semantic proof, require fresh verification for non-trivial completion, and fail closed when a high-risk capability is missing.",
      })
    })

      await ctx.session.hook("prompt", (event) => {
      const config = routerConfig()
      if (!config.enabled) return

      let policy = null
      try {
        policy = runOcskillJSON(["task-policy", event.prompt.text], projectRoot)
      } catch {}
      const intent = classifyIntent(event.prompt.text, routingFacts)
      const effectiveMaxSkills = Math.max(
        1,
        Math.min(config.maxSkills, Number(policy?.maxSkills || config.maxSkills)),
      )
      const selected = []
      for (const id of [...routeSkills(event.prompt.text, effectiveMaxSkills, routingFacts), ...policySkills(policy)]) {
        if (!selected.includes(id)) selected.push(id)
        if (selected.length >= effectiveMaxSkills) break
      }
      if (selected.length === 0) return

      event.prompt.skills ??= []
      if (!Array.isArray(event.prompt.skills)) return

      for (const id of selected) {
        if (!event.prompt.skills.includes(id)) event.prompt.skills.push(id)
      }

      event.metadata = {
        ...event.metadata,
        uesRouter: {
          selected,
          policy,
          intent,
          facts: {
            repoStacks: routingFacts.repoStacks,
            feedbackDomains: routingFacts.feedbackDomains,
            acceptedLearningCount: routingFacts.acceptedLearningCount,
          },
          version: 6,
          effectiveMaxSkills,
        },
      }
    })

    }

    if (capabilities.permissionHook) {
      await ctx.permission.hook("evaluate", (event) => {
        if (event.action !== "shell") return
        const risk = destructiveShellRisk(event.resources.join("\n"))
        if (!risk.risky) return
        event.effect = "ask"
        event.message = "UES safety gate: confirm destructive/high-impact shell action (" + risk.id + ")."
      })
    }
  },
})
