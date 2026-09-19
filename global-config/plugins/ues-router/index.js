import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { routeSkills } from "./router.js"
import { destructiveShellRisk } from "./safety.js"

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
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "ocskill command failed").trim())
  }
  return (result.stdout || "").trim()
}

export default Plugin.define({
  id: "ues-router",
  async setup(ctx) {
    const projectRoot = ctx.location.project?.canonical || ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ues",
        description: "Read-only UES long-horizon state and deterministic planning evidence.",
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
    })

    await ctx.session.hook("context", (event) => {
      if (event.agent === "title" || event.agent === "summary" || event.agent === "compaction") return
      event.system.push({
        type: "text",
        text: "UES V6 runtime: for long tasks trust durable .ues-work state over conversation memory, keep task contexts focused, require fresh verification before completion, and ask before destructive/external side effects.",
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
          version: 2,
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
