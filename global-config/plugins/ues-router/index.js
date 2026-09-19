import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

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

function add(list, id) {
  if (!list.includes(id)) list.push(id)
}

function route(text, maxSkills) {
  const value = String(text || "").toLowerCase()
  const routed = []
  const risky = /(migration|schema|database|sql|auth|permission|security|payment|webhook|public api|contract|dependency|deploy|ci|production|rollback)/
  const nonTrivial = value.length > 220 || risky.test(value) || /(implement|feature|refactor|fix|debug|investigate|review|audit)/.test(value)

  if (nonTrivial) add(routed, "ues-engineering-orchestrator")
  if (/(bug|crash|regression|failing|failure|error|exception|broken|debug)/.test(value)) add(routed, "ues-bug-diagnosis")
  if (/(latest|current docs|documentation|release notes|version compatibility|dependency|package version|api changed)/.test(value)) add(routed, "ues-research-verification")

  if (/(react native|expo|android|ios|gradle|xcode|metro)/.test(value)) add(routed, "ues-react-native-engineering")
  else if (/(next\.js|nextjs|app router|server component)/.test(value)) add(routed, "ues-nextjs-engineering")
  else if (/(react|hook|useeffect|usestate|component)/.test(value)) add(routed, "ues-react-engineering")

  if (/(database|schema|migration|sql|query|index|transaction)/.test(value)) {
    add(routed, "ues-database-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(auth|authorization|authentication|permission|role|tenant|idor|token|session)/.test(value)) {
    add(routed, "ues-auth-security")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(payment|checkout|webhook|refund|idempotenc)/.test(value)) {
    add(routed, "ues-payment-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(api contract|openapi|response schema|request schema|breaking api|public api)/.test(value)) {
    add(routed, "ues-api-contract")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(docker|github actions|ci\/cd|pipeline|deploy|kubernetes|container)/.test(value)) add(routed, "ues-devops-engineering")
  if (/(performance|slow|latency|memory leak|n\+1|bundle size)/.test(value)) add(routed, "ues-performance-engineering")
  if (/(accessibility|a11y|screen reader|keyboard navigation|aria)/.test(value)) add(routed, "ues-accessibility")
  if (/(upload|file upload|multipart|object storage)/.test(value)) add(routed, "ues-file-upload-engineering")
  if (/(ecommerce|marketplace|inventory|cart|catalog|order)/.test(value)) add(routed, "ues-ecommerce-engineering")

  if (routed.length === 0 && /(code|repository|repo|project|function|class|endpoint|test)/.test(value)) {
    add(routed, "ues-repo-explorer")
  }

  return routed.slice(0, maxSkills)
}

export default Plugin.define({
  id: "ues-router",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const config = routerConfig()
      if (!config.enabled) return

      const selected = route(event.prompt.text, config.maxSkills)
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
          version: 1,
        },
      }
    })
  },
})
