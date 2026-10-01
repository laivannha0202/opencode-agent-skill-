const WRITER_ROLES = new Set(["executor", "architect", "debugger", "ues-executor", "ues-architect", "ues-debugger"])

export function solutionEconomyContract(options = {}) {
  const role = String(options.role || "")
  const risk = String(options.risk || "medium").toLowerCase()
  const active = WRITER_ROLES.has(role)
  if (!active) return { schemaVersion: 1, active: false, text: "" }
  const strictSafety = ["high", "critical"].includes(risk)
  const lines = [
    "## UES Solution Economy Gate",
    "Understand the real flow first; minimal does not mean shallow.",
    "Before adding code, check in order: reuse an existing repo pattern/helper; standard library; native framework/platform primitive; already-installed dependency; only then add the smallest new implementation that fully satisfies the task.",
    "Prefer deletion/reuse and the fewest necessary files. Do not add speculative abstractions, dependencies, configuration layers or scaffolding.",
    "A smaller diff is only better after correctness is established.",
    "Never simplify away explicit requirements, trust-boundary validation, data-loss/error handling, security, accessibility, compatibility, required observability, or verification.",
    strictSafety
      ? "High-risk task: correctness and independent verification dominate economy; do not trade safety for fewer lines."
      : "Leave the narrowest runnable verification that proves non-trivial changed behavior.",
  ]
  return {
    schemaVersion: 1,
    active: true,
    risk,
    mode: strictSafety ? "safety-first" : "minimal-correct-diff",
    text: lines.join("\n"),
  }
}
