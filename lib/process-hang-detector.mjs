const SHELL_TOOLS = new Set(["bash", "powershell"])

const JEST_OPEN_HANDLE =
  /Jest did not exit one second after the test run has completed\.?/i

const JEST_OPEN_HANDLE_HINT =
  /asynchronous operations that weren't stopped in your tests|--detectOpenHandles/i

function bounded(text, limit = 6000) {
  const value = String(text || "")
  return value.length <= limit ? value : value.slice(value.length - limit)
}

export function toolResultText(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => toolResultText(item)).filter(Boolean).join("\n")
  if (typeof value !== "object") return String(value)

  if (typeof value.text === "string") return value.text
  if (Array.isArray(value.content)) {
    return value.content
      .map((item) => toolResultText(item))
      .filter(Boolean)
      .join("\n")
  }
  if (value.partialResult) return toolResultText(value.partialResult)
  if (value.result) return toolResultText(value.result)
  return ""
}

export function detectHungToolEvidence(input = {}) {
  const toolName = String(input.toolName || "").toLowerCase()
  if (!SHELL_TOOLS.has(toolName)) return null

  const text = String(input.text || "")
  if (!text) return null

  if (JEST_OPEN_HANDLE.test(text)) {
    return {
      schemaVersion: 1,
      kind: "jest-open-handle",
      confidence: "high",
      toolName,
      message:
        "Jest reported that the test run completed but the process did not exit, indicating an open async handle/resource leak.",
      evidence: bounded(text),
      diagnosticHint: JEST_OPEN_HANDLE_HINT.test(text)
        ? "Run the narrow failing suite with --detectOpenHandles and close leaked timers, servers, Prisma/Redis/BullMQ connections or workers."
        : "Run the narrow failing suite with --detectOpenHandles and inspect leaked async resources.",
    }
  }

  return null
}

export function isToolExecutionError(event = {}) {
  return event?.type === "tool_execution_end" && event?.isError === true
}
