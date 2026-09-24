import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { compactReversibleOutput } from "../../lib/performance-fabric.mjs";
import { getEvidence } from "../../lib/evidence-store.mjs";

function configuredLimit() {
  const raw = Number(process.env.UES_CHILD_TOOL_OUTPUT_LIMIT || 24 * 1024);
  if (!Number.isFinite(raw)) return 24 * 1024;
  return Math.max(4 * 1024, Math.min(128 * 1024, Math.trunc(raw)));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (String(process.env.UES_CHILD_TOOL_COMPACTION || "") !== "1") return undefined;
    if (!["bash", "powershell", "grep", "find", "ls"].includes(String(event.toolName || ""))) {
      return undefined;
    }

    const rawText = (event.content || [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    const images = (event.content || []).filter((part: any) => part?.type !== "text");
    const maxChars = configuredLimit();
    if (!rawText || rawText.length <= maxChars) return undefined;

    const commandHint = String(
      (event.input as any)?.command ||
      (event.input as any)?.pattern ||
      event.toolName ||
      "tool",
    );
    const compacted = await compactReversibleOutput(ctx.cwd, rawText, {
      maxChars,
      kind: `child-${event.toolName}-output`,
      source: commandHint,
    }).catch(() => null);
    if (!compacted?.compacted) return undefined;

    return {
      content: [{ type: "text", text: compacted.text }, ...images],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        uesCompaction: {
          strategy: compacted.strategy,
          originalChars: compacted.originalChars,
          returnedChars: compacted.returnedChars,
          evidenceRef: compacted.evidenceRef,
          recoveryTool: "ues_evidence_get",
        },
      },
      isError: event.isError,
      usage: event.usage,
    };
  });

  pi.registerTool({
    name: "ues_evidence_get",
    label: "UES Evidence Get",
    description:
      "Read an exact bounded slice from a UES Evidence Store reference when a compacted tool result says omitted raw evidence is available.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
      start: Type.Optional(Type.Number({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 64000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await getEvidence(ctx.cwd, params.ref, {
          start: params.start || 0,
          maxBytes: params.maxBytes || 16000,
        });
        return {
          content: [{
            type: "text",
            text: [
              `ref: ${result.ref}`,
              `bytes: ${result.bytes}; start: ${result.start}; returned: ${result.returnedBytes}; truncated: ${result.truncated}`,
              "",
              result.content,
            ].join("\n"),
          }],
          details: {
            ref: result.ref,
            start: result.start,
            returnedBytes: result.returnedBytes,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          }],
          details: { ref: params.ref },
          isError: true,
        };
      }
    },
  });
}
