import { spawnSync } from "node:child_process"

export function hermesStatus() {
  const result = spawnSync("hermes", ["--version"], { encoding: "utf8" })
  return {
    available: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
    error: result.status === 0 ? null : String(result.stderr || result.stdout || "Hermes CLI not found").trim(),
  }
}

export function buildHermesDelegationPrompt(contextPack) {
  return [
    "You are an optional external executor for a UES task.",
    "Implement exactly the approved task described below.",
    "Do not broaden scope, merge, push, publish, deploy, or alter durable UES state.",
    "Run the declared verification and return a concise structured report.",
    "",
    JSON.stringify(contextPack, null, 2),
  ].join("\n")
}


export function hermesOneShotArgs(prompt) {
  const text = String(prompt || "").trim()
  if (!text) throw new Error("Hermes one-shot prompt is required")
  return ["chat", "-q", text]
}
