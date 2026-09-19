import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
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

export default Plugin.define({
  id: "ues-router",
  async setup(ctx) {
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
