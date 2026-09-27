const COMMAND_LABELS = Object.freeze({
  run: "UES",
  resume: "UES Resume",
  fix: "UES Fix",
  feature: "UES Feature",
  debug: "UES Debug",
  review: "UES Review",
  audit: "UES Audit",
  plan: "UES Plan",
  research: "UES Research",
  critique: "UES Critique",
  verify: "UES Verify",
})

function clipUnicode(value, maxLength) {
  const chars = Array.from(String(value || ""))
  if (chars.length <= maxLength) return chars.join("")
  if (maxLength <= 1) return "…"
  return chars.slice(0, maxLength - 1).join("") + "…"
}

export function compactSessionSubject(value, maxLength = 56) {
  const compact = String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*#>\s]+/, "")
    .trim()
  return clipUnicode(compact, Math.max(8, Number(maxLength || 56)))
}

function workspaceLabel(cwd) {
  const normalized = String(cwd || "").replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").filter(Boolean).at(-1) || "workspace"
}

export function uesSessionName(kind, subject = "", cwd = "", maxLength = 72) {
  const normalizedKind = String(kind || "run").toLowerCase()
  const label = COMMAND_LABELS[normalizedKind] || "UES"
  const subjectBudget = Math.max(8, Number(maxLength || 72) - label.length - 2)
  const detail = compactSessionSubject(subject, subjectBudget) || compactSessionSubject(workspaceLabel(cwd), subjectBudget)
  return clipUnicode(label + ": " + detail, Math.max(16, Number(maxLength || 72)))
}

export function sessionNameFromUesInput(input, cwd = "", maxLength = 72) {
  const text = String(input || "").trim()
  const match = text.match(/^\/ues-(run|resume|fix|feature|debug|review|audit|plan|research|critique|verify)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return uesSessionName(match[1], match[2] || "", cwd, maxLength)
}
