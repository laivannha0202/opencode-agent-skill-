import { spawnSync } from "node:child_process"
import { resolveWindowsCommand } from "./windows-shim.mjs"

function runHermesVersion() {
  if (process.platform !== "win32") return spawnSync("hermes", ["--version"], { encoding: "utf8" })
  const resolved = resolveWindowsCommand("hermes")
  if (!resolved) return { status: 127, stdout: "", stderr: "Hermes CLI not found" }
  return spawnSync(resolved.executable, [...resolved.argsPrefix, "--version"], { encoding: "utf8" })
}

export function hermesStatus() {
  const result = runHermesVersion()
  return {
    available: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
    error: result.status === 0 ? null : String(result.stderr || result.stdout || "Hermes CLI not found").trim(),
    mode: "optional-sidecar",
  }
}

export function buildHermesDelegationPrompt(contextPack) {
  return [
    "You are an optional external executor for a UES task.",
    "Implement exactly the approved task described below.",
    "Do not broaden scope, merge, push, publish, deploy, or alter durable UES state.",
    "Run the declared verification and return a concise structured report.",
    "Large evidence is referenced by evidence:sha256 pointers; fetch only the slice required for the task.",
    "",
    JSON.stringify(contextPack, null, 2),
  ].join("\n")
}

export function buildHermesWorkflowPrompt(contextPack, schedule) {
  return [
    "You are the optional Hermes sidecar for a UES V11 dynamic workflow.",
    "Follow the supplied bounded wave schedule. Deterministic tasks are not delegated to LLM children.",
    "Never exceed declared task ownership or concurrency. Persist outputs/evidence to files instead of conversational summaries.",
    "Do not merge, push, publish, deploy, or mutate durable UES state except through explicitly supplied UES commands.",
    "",
    "SCHEDULE:",
    JSON.stringify(schedule, null, 2),
    "",
    "CONTEXT:",
    JSON.stringify(contextPack, null, 2),
  ].join("\n")
}

export function hermesSidecarPlan(input = {}) {
  return {
    schemaVersion: 2,
    adapter: "hermes",
    optional: true,
    mode: input.mode || "one-shot",
    maxConcurrent: Math.max(1, Math.min(16, Number(input.maxConcurrent || 4))),
    durableStateOwner: "ues",
    evidenceTransport: "content-addressed-pointers",
    allowNestedDelegation: input.allowNestedDelegation === true,
    safety: {
      merge: false,
      push: false,
      publish: false,
      deploy: false,
      destructiveGit: false,
    },
  }
}

export function hermesOneShotArgs(prompt) {
  const text = String(prompt || "").trim()
  if (!text) throw new Error("Hermes one-shot prompt is required")
  return ["chat", "-q", text]
}
