import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export const UES_PROMPT_ALIASES = Object.freeze([
  "ues-audit",
  "ues-critique",
  "ues-debug",
  "ues-feature",
  "ues-fix",
  "ues-plan",
  "ues-research",
  "ues-resume",
  "ues-review",
  "ues-run",
  "ues-verify",
])

const ALIAS_SET = new Set(UES_PROMPT_ALIASES)

export function normalizeUesPromptPaste(text) {
  let value = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/^[\u200B-\u200D]+/, "")

  const trimmed = value.trim()
  const fenced = trimmed.match(/^\`\`\`(?:text|txt|md|markdown|prompt|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n\`\`\`\s*$/i)
  if (fenced) value = fenced[1]

  return value
}

export function policySourceForPromptAlias(promptAlias, promptText) {
  if (!promptAlias) return normalizeUesPromptPaste(promptText).trim()

  const args = String(promptAlias.arguments || "").trim()
  if (promptAlias.alias === "ues-resume") {
    return [
      "Resume an existing durable UES execution.",
      args,
    ].filter(Boolean).join("\n")
  }

  return args || `/${promptAlias.alias}`
}

export function promptAliasTextForPolicy(promptAlias, policy) {
  if (!promptAlias) return null
  if (promptAlias.alias !== "ues-run") return promptAlias.text

  const args = String(promptAlias.arguments || "").trim()
  const mode = String(policy?.mode || "").toLowerCase()
  const risk = String(policy?.risk || "").toLowerCase()
  const profile = String(policy?.executionProfile || policy?.profile?.name || "").toLowerCase()
  const isDeep = mode === "long-horizon" || risk === "high" || profile === "deep"

  if (!isDeep && profile === "fast") {
    return [
      "UES V2 prompt alias: /ues-run. Adaptive policy selected FAST from the actual user request.",
      "Preserve the user's exact requested outcome and response constraints.",
      "Do not initialize .ues-work, create SPEC/PLAN state, inspect the repository, dispatch subagents, or run verification unless the request itself requires repository work or machine-checkable evidence.",
      "If the request is directly answerable, answer it directly now.",
      "",
      "User request:",
      args,
    ].join("\n").trim()
  }

  if (!isDeep && profile === "standard") {
    return [
      "UES V2 prompt alias: /ues-run. Adaptive policy selected STANDARD from the actual user request.",
      "Preserve the user's exact requested outcome and approval boundaries.",
      "Use targeted repository evidence, bounded edits, and targeted + affected verification.",
      "Do not create durable .ues-work state, plan gates, integration gates, or parallel workers unless new evidence justifies reclassification to DEEP/high-risk.",
      "",
      "User request:",
      args,
    ].join("\n").trim()
  }

  return promptAlias.text
}

export function policyPromptForCli(text, maxChars = 12_000) {
  const raw = normalizeUesPromptPaste(text).trim()
  const limit = Math.max(2_000, Number(maxChars) || 12_000)
  if (raw.length <= limit) {
    return { text: raw, truncated: false, originalChars: raw.length, cliChars: raw.length }
  }

  const marker = "\n\n[UES_POLICY_INPUT_TRUNCATED_FOR_CLI]\n\n"
  const usable = Math.max(1, limit - marker.length)
  const headChars = Math.floor(usable * 0.72)
  const tailChars = usable - headChars
  const bounded = raw.slice(0, headChars) + marker + raw.slice(-tailChars)
  return {
    text: bounded,
    truncated: true,
    originalChars: raw.length,
    cliChars: bounded.length,
  }
}

function parseFrontmatter(source) {
  const text = String(source || "")
  if (!text.startsWith("---")) return { metadata: {}, body: text }
  const end = text.indexOf("\n---", 3)
  if (end < 0) return { metadata: {}, body: text }

  const block = text.slice(3, end).trim()
  const metadata = {}
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    metadata[match[1]] = match[2].trim()
  }

  return {
    metadata,
    body: text.slice(end + 4).replace(/^\r?\n/, ""),
  }
}

function splitArgs(input) {
  const value = String(input || "")
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) || []
  return matches.map((item) => item.replace(/^(['"])([\s\S]*)\1$/, "$2"))
}

export function expandUesPromptAlias(text, templateDir) {
  const raw = normalizeUesPromptPaste(text)
  const match = raw.match(/^\s*\/(ues-[a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*?))?\s*$/i)
  if (!match) return null

  const alias = match[1].toLowerCase()
  if (!ALIAS_SET.has(alias)) return null

  const args = String(match[2] || "").trim()
  const sourceName = alias.slice("ues-".length) + ".md"
  const file = path.join(templateDir, sourceName)
  if (!existsSync(file)) return null

  const { metadata, body } = parseFrontmatter(readFileSync(file, "utf8"))
  const positional = splitArgs(args)
  let expanded = body.replaceAll("$ARGUMENTS", args)
  expanded = expanded.replace(/\$(\d+)/g, (_, value) => positional[Number(value) - 1] || "")

  const agent = metadata.agent || null
  const prelude = [
    `UES V2 prompt alias: /${alias}. Preserve the command contract below while using the normal session.prompt path.`,
    agent && agent !== "build"
      ? `Preferred specialist: ${agent}. When fresh subagent dispatch is available, delegate to that specialist and preserve the command's read/write restrictions.`
      : null,
  ].filter(Boolean).join("\n")

  return {
    alias,
    arguments: args,
    agent,
    sourceName,
    text: `${prelude}\n\n${expanded.trim()}`,
  }
}
