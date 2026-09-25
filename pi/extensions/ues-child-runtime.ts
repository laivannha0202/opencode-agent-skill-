    .map((part: any) => part.text)
    .join("\n");
}

async function capturedText(event: any, fallback: string) {
  const fullOutputPath = String((event.details as any)?.fullOutputPath || "").trim();
  if (!fullOutputPath) return { text: fallback, full: false, sourcePath: null };

  try {
    const info = await stat(fullOutputPath);
    if (!info.isFile() || info.size <= 0 || info.size > configuredRawCaptureLimit()) {
      return { text: fallback, full: false, sourcePath: fullOutputPath };
    }
    return {
      text: await readFile(fullOutputPath, "utf8"),
      full: true,
      sourcePath: fullOutputPath,
    };
  } catch {
    return { text: fallback, full: false, sourcePath: fullOutputPath };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const toolName = String(event.toolName || "");
    if (!["bash", "powershell"].includes(toolName)) return undefined;

    const command = String((event.input as any)?.command || "");
    const risk = destructiveShellRisk(command);
    if (risk.risky) {
      return {
        block: true,
        reason:
          `UES child safety blocked ${risk.id || "destructive"} shell operation` +
          (risk.segment ? `: ${risk.segment}` : ""),
      };
    }

    toolStartedAt.set(String(event.toolCallId || ""), Date.now());
    if (looksLikeVerificationCommand(command) && (event.input as any)?.timeout == null) {
      (event.input as any).timeout = configuredVerificationTimeout();
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = String(event.toolName || "");
    if (!["bash", "powershell", "grep", "find", "ls"].includes(toolName)) {
      return undefined;
    }

    const shownText = visibleText(event);
    const capture = await capturedText(event, shownText);
    const rawText = capture.text;
    const images = (event.content || []).filter((part: any) => part?.type !== "text");
    const commandHint = String(
      (event.input as any)?.command ||
      (event.input as any)?.pattern ||
      toolName ||
      "tool",