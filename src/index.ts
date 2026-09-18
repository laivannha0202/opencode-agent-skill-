import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { loadCommands, loadSkills } from "./assets.ts"

type PluginOptions = {
  injectBuildWorkflow?: boolean
  commandPrefix?: string
  agents?: string[]
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

function normalizePrefix(value: unknown): string {
  if (typeof value !== "string") return "ues"
  const clean = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "")
  return clean || "ues"
}

export default Plugin.define({
  id: "universal-engineering-system",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as PluginOptions
    const skills = await loadSkills(packageRoot)
    const commands = await loadCommands(packageRoot)
    const workflow = await readFile(
      path.join(packageRoot, "global-config", "AGENTS.md"),
      "utf8",
    )

    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        // Respect a skill already supplied by the user/project.
        if (editor.get(skill.id)) continue

        editor.add({
          ...skill,
          autoinvoke: true,
        })
      }
    })

    const commandPrefix = normalizePrefix(options.commandPrefix)
    await ctx.command.transform((editor) => {
      for (const command of commands) {
        editor.add({
          name: `${commandPrefix}-${command.id}`,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            const args = prompt.text ?? ""
            const text = command.template.includes("$ARGUMENTS")
              ? command.template.replaceAll("$ARGUMENTS", args)
              : [command.template, args].filter(Boolean).join("\n\n")

            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text,
              delivery,
            })
          },
        })
      }
    })

    if (options.injectBuildWorkflow !== false) {
      const targetAgents = new Set(
        Array.isArray(options.agents) && options.agents.length > 0
          ? options.agents
          : ["build"],
      )

      await ctx.session.hook("context", (event) => {
        if (!targetAgents.has(event.agent)) return

        event.system.push({
          type: "text",
          text: [
            "Universal Engineering System is active.",
            "Use the available skill tool only for skills relevant to the current task.",
            workflow.trim(),
          ].join("\n\n"),
        })
      })
    }
  },
})
