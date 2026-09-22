function assistantTextParts(message) {
  const role = String(message?.info?.role || message?.role || "").toLowerCase()
  if (role !== "assistant") return []
  const values = []
  for (const part of message?.parts || []) {
    if (part?.type === "text" && typeof part.text === "string") values.push(part.text)
  }
  if (values.length === 0 && typeof message?.content === "string") values.push(message.content)
  return values
}

export function extractVerifierVerdict(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let messageIndex = list.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = assistantTextParts(list[messageIndex])
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const lines = parts[partIndex].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const line = lines[lineIndex]
        if (!line.startsWith("UES_VERDICT_JSON:")) continue
        const raw = line.slice("UES_VERDICT_JSON:".length).trim()
        try {
          const parsed = JSON.parse(raw)
          const verdict = String(parsed.verdict || "").toUpperCase()
          const evidence = String(parsed.evidence || "").trim().slice(0, 4000)
          if (verdict === "PASS" && evidence.length < 3) continue
          if (["PASS", "FAIL"].includes(verdict)) return { verdict, evidence }
        } catch {}
      }
    }
  }
  return null
}
