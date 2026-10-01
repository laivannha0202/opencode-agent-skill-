import { selectSkillNames } from "../lib/skill-compiler.mjs"
import { evaluateSkillActivation, skillDietDecision } from "../lib/skill-activation.mjs"

const cases = [
  { id: "debug-1", role: "debugger", task: "debug checkout regression and failing tests", policy: {}, expected: ["bug-diagnosis", "test-verification"] },
  { id: "verify-1", role: "verifier", task: "verify regression tests", policy: {}, expected: ["test-verification"] },
  { id: "plan-1", role: "architect", task: "plan a multi-step architecture migration", policy: {}, expected: ["software-architect", "task-planner"] },
  { id: "review-1", role: "reviewer", task: "review code changes", policy: {}, expected: ["code-review"] },
  { id: "map-1", role: "codebase-mapper", task: "map repository context", policy: {}, expected: ["repo-explorer", "context-engineering"] },
  { id: "security-1", role: "executor", task: "fix auth authorization security regression", policy: { domains: ["auth-security"] }, expected: ["implementation-engineer", "auth-security"] },
  { id: "db-1", role: "executor", task: "database transaction migration", policy: { domains: ["database"] }, expected: ["implementation-engineer", "database-engineering"] },
  { id: "rn-1", role: "executor", task: "react native mobile fix", policy: { domains: ["react-native"] }, expected: ["implementation-engineer", "react-native-engineering"] },
  { id: "next-1", role: "executor", task: "nextjs route fix", policy: { domains: ["nextjs"] }, expected: ["implementation-engineer", "nextjs-engineering"] },
  { id: "api-1", role: "executor", task: "api contract compatibility", policy: { domains: ["api-contract"] }, expected: ["implementation-engineer", "api-contract"] },
  { id: "merge-1", role: "merge-arbiter", task: "resolve integration conflict safely", policy: {}, expected: ["git-safety", "change-impact-analysis"] },
  { id: "visual-1", role: "visual-verifier", task: "verify responsive visual behavior in browser", policy: {}, expected: ["visual-fidelity", "responsive-verification", "browser-qa"] },
]

const activations = cases.map((row) => ({
  id: row.id,
  selected: selectSkillNames(row.policy, row.role, { taskText: row.task, maxSkills: 5 }),
}))
const stats = evaluateSkillActivation(cases, activations)
const diet = skillDietDecision(stats, { minCases: 8 })
const pass = stats.precision >= 0.9 && stats.recall >= 0.85
console.log(JSON.stringify({ schemaVersion: 1, pass, stats, diet, activations }, null, 2))
if (!pass) process.exitCode = 1
