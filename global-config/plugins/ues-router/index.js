import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { routeSkills } from "./router.js"
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


function runOcskill(args, cwd) {
  const result = spawnSync("ocskill", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 4 * 1024 * 1024,
  })
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
        name: "dispatch_task",
        description: "Start one approved UES task and execute it in a fresh ues-executor session, applying configured attempt-based model escalation when available. The parent must inspect the diff and record completion evidence separately.",
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
        execute: async (input, tool) => {
          if (!capabilities.freshDispatch) {
            throw new Error("OpenCode runtime does not expose the fresh-session capabilities required by ues.dispatch_task")
          }
          await tool.progress({ status: "starting fresh UES executor" })
          const started = runOcskillJSON(["work", "start", input.slug, input.task, projectRoot], projectRoot)
          const attempt = started?.record?.attempts || 1
          const runId = started?.record?.runId || null
          const taskText = [
            started?.contextPack?.task?.title,
            started?.contextPack?.task?.summary,
            ...(started?.contextPack?.task?.acceptance || []),
          ].filter(Boolean).join(" ")
          const taskPolicy = runOcskillJSON(["task-policy", taskText], projectRoot)
          const policyArgs = ["model-policy", "executor", "--attempt", String(attempt)]
          if (taskText) policyArgs.push("--text", taskText)
          const policy = runOcskillJSON(policyArgs, projectRoot)
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
            const created = await ctx.session.create({ title: "UES " + input.slug + " " + input.task })
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
            await ctx.session.wait({ sessionID: created.id })
            const messages = await ctx.session.context({ sessionID: created.id })
            return {
              content: JSON.stringify({
                sessionID: created.id,
                task: input.task,
                attempt,
                runId,
                taskPolicy,
                model: policy,
                messages: messageExcerpt(messages),
                next: "Inspect the child diff and verification, then call ocskill work complete or fail.",
              }, null, 2),
            }
          } catch (error) {
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

    await ctx.session.hook("context", (event) => {
      if (event.agent === "title" || event.agent === "summary" || event.agent === "compaction") return
      event.system.push({
        type: "text",
        text: "UES V7 runtime: classify task complexity/risk, trust durable .ues-work state over conversation memory, use lease-backed fresh execution when supported, prefer structured verification receipts, recover stale work after interruption, and require integration evidence before completion.",
      })
    })

    await ctx.session.hook("prompt", (event) => {
      const config = routerConfig()
      if (!config.enabled) return

      const selected = routeSkills(event.prompt.text, config.maxSkills)
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
          version: 3,
        },
      }
    })

    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "shell") return
      const risk = destructiveShellRisk(event.resources.join("\n"))
      if (!risk.risky) return
      event.effect = "ask"
      event.message = "UES safety gate: confirm destructive/high-impact shell action (" + risk.id + ")."
    })
  },
})
