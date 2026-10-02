function serializedChars(value) {
  try { return JSON.stringify(value ?? null).length } catch { return String(value ?? "").length }
}

function hasOpaqueProviderSignature(message = {}) {
  if (!Array.isArray(message?.content)) return false
  return message.content.some((block) =>
    Boolean(block?.thoughtSignature || block?.thinkingSignature || block?.textSignature),
  )
}

function compactValue(value, options, depth = 0) {
  const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth || 5)))
  const maxStringChars = Math.max(64, Math.min(2048, Number(options.maxStringChars || 256)))
  const maxArrayItems = Math.max(2, Math.min(32, Number(options.maxArrayItems || 6)))
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.length <= maxStringChars) return value
    const head = value.slice(0, Math.min(96, maxStringChars))
    return head + `...[UES pruned stale failed input: ${value.length} chars]`
  }
  if (depth >= maxDepth) {
    return `[UES pruned stale failed input subtree: ${serializedChars(value)} chars]`
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArrayItems).map((item) => compactValue(item, options, depth + 1))
    if (value.length > maxArrayItems) {
      kept.push(`[UES pruned ${value.length - maxArrayItems} additional stale failed-input items]`)
    }
    return kept
  }
  if (typeof value === "object") {
    const result = {}
    const entries = Object.entries(value)
    const maxObjectKeys = Math.max(4, Math.min(64, Number(options.maxObjectKeys || 24)))
    for (const [key, item] of entries.slice(0, maxObjectKeys)) {
      result[key] = compactValue(item, options, depth + 1)
    }
    if (entries.length > maxObjectKeys) {
      result.__uesPrunedKeys = entries.length - maxObjectKeys
    }
    return result
  }
  return String(value)
}

function failedResultIndexes(messages = []) {
  const output = new Map()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== "toolResult" || message?.isError !== true) continue
    const id = String(message?.toolCallId || "").trim()
    if (id) output.set(id, index)
  }
  return output
}

export function pruneStaleFailedToolInputs(messages = [], options = {}) {
  const source = Array.isArray(messages) ? messages : []
  const cacheMode = String(options.cacheMode || "neutral").toLowerCase()
  if (cacheMode === "cache") {
    return {
      schemaVersion: 1,
      changed: false,
      messages: source,
      prunedCalls: 0,
      beforeChars: 0,
      afterChars: 0,
      savedChars: 0,
      skippedSigned: 0,
      reason: "cache-prefix-preservation",
    }
  }

  const minAgeMessages = Math.max(2, Math.min(64, Math.trunc(Number(options.minAgeMessages || 6))))
  const minInputChars = Math.max(512, Math.min(128 * 1024, Math.trunc(Number(options.minInputChars || 2048))))
  const minSavedChars = Math.max(128, Math.min(32 * 1024, Math.trunc(Number(options.minSavedChars || 512))))
  const failed = failedResultIndexes(source)
  if (!failed.size) {
    return {
      schemaVersion: 1,
      changed: false,
      messages: source,
      prunedCalls: 0,
      beforeChars: 0,
      afterChars: 0,
      savedChars: 0,
      skippedSigned: 0,
      reason: "no-failed-tool-results",
    }
  }

  let changed = false
  let prunedCalls = 0
  let beforeChars = 0
  let afterChars = 0
  let skippedSigned = 0
  const next = source.map((message, messageIndex) => {
    if (message?.role !== "assistant" || !Array.isArray(message?.content)) return message
    const candidates = message.content.filter((block) => {
      if (block?.type !== "toolCall") return false
      const resultIndex = failed.get(String(block?.id || ""))
      if (resultIndex == null) return false
      return source.length - 1 - resultIndex >= minAgeMessages
    })
    if (!candidates.length) return message
    if (hasOpaqueProviderSignature(message)) {
      skippedSigned += candidates.length
      return message
    }

    let messageChanged = false
    const content = message.content.map((block) => {
      if (block?.type !== "toolCall") return block
      const resultIndex = failed.get(String(block?.id || ""))
      if (resultIndex == null || source.length - 1 - resultIndex < minAgeMessages) return block
      const originalChars = serializedChars(block.arguments)
      if (originalChars < minInputChars) return block
      const compacted = compactValue(block.arguments, options)
      const compactedChars = serializedChars(compacted)
      if (originalChars - compactedChars < minSavedChars) return block
      messageChanged = true
      changed = true
      prunedCalls += 1
      beforeChars += originalChars
      afterChars += compactedChars
      return {
        ...block,
        arguments: compacted,
      }
    })
    return messageChanged ? { ...message, content } : message
  })

  return {
    schemaVersion: 1,
    changed,
    messages: changed ? next : source,
    prunedCalls,
    beforeChars,
    afterChars,
    savedChars: Math.max(0, beforeChars - afterChars),
    skippedSigned,
    reason: changed ? "stale-failed-input-pruned" : "no-eligible-stale-failed-input",
  }
}
