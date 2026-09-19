import path from "node:path"
import { detectStack, detectTestCommands, checkWorkingTree } from "./repo-inspect.mjs"
import { reviewScope } from "./review-scope.mjs"

export async function buildVerificationPlan(root = process.cwd(), base = null) {
  root = path.resolve(root)
  const [stack, commands, workingTree] = await Promise.all([
    detectStack(root),
    detectTestCommands(root),
    checkWorkingTree(root),
  ])
  const scope = reviewScope(root, base)

  const recommended = []
  const add = (kind, command, reason) => {
    if (!command || recommended.some((item) => item.command === command)) return
    recommended.push({ kind, command, reason })
  }

  for (const item of commands) {
    if (["test", "typecheck", "check", "lint", "build", "analyze", "ci"].includes(item.kind)) {
      add(item.kind, item.command, "project-native " + item.kind + " command from " + item.source)
    }
  }

  if (scope.git && ["high", "critical"].includes(scope.overallRisk)) {
    add("diff-review", "git diff --check", "high-risk changes require whitespace/conflict-marker sanity")
  }

  const acceptancePrompts = []
  if (scope.git) {
    for (const file of scope.files) {
      for (const reason of file.risk.reasons) {
        if (reason === "auth/security") acceptancePrompts.push("Verify denied/unauthorized cases, not only the happy path.")
        if (reason === "payment") acceptancePrompts.push("Verify idempotency/retry/state-transition behavior with negative cases.")
        if (reason === "persistence/schema") acceptancePrompts.push("Verify migration compatibility, existing rows, rollback/roll-forward behavior.")
        if (reason === "public/interface") acceptancePrompts.push("Verify producers and consumers of changed contracts.")
        if (reason === "delivery/infrastructure") acceptancePrompts.push("Verify configuration/deployment behavior in a representative environment.")
      }
    }
  }

  return {
    schemaVersion: 1,
    root,
    stack,
    workingTree,
    scope,
    recommended,
    acceptancePrompts: [...new Set(acceptancePrompts)],
  }
}
