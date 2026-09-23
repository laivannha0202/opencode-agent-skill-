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
  const raw = String(text || "")
  const match = raw.match(/^\s*\/(ues-[a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+([\s\S]*))?\s*$/i)
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
