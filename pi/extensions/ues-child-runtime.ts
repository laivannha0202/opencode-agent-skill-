import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { compactReversibleOutput } from "../../lib/performance-fabric.mjs";
import { getEvidenceSelected } from "../../lib/evidence-store.mjs";
import { recordVerification } from "../../lib/verification-broker.mjs";
import { destructiveShellRisk } from "../../lib/safety.mjs";
import {
  canRecordReusableVerification,
  looksLikeVerificationCommand,
} from "../../lib/verification-command.mjs";

const toolStartedAt = new Map<string, number>();

function configuredLimit() {
  const raw = Number(process.env.UES_CHILD_TOOL_OUTPUT_LIMIT || 24 * 1024);
  if (!Number.isFinite(raw)) return 24 * 1024;
  return Math.max(4 * 1024, Math.min(128 * 1024, Math.trunc(raw)));
}

function configuredVerificationTimeout() {
  const raw = Number(process.env.UES_CHILD_VERIFICATION_TIMEOUT_SEC || 300);
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.max(30, Math.min(1800, Math.trunc(raw)));
}

function configuredRawCaptureLimit() {
  const raw = Number(process.env.UES_CHILD_RAW_CAPTURE_LIMIT || 32 * 1024 * 1024);
  if (!Number.isFinite(raw) || raw <= 0) return 32 * 1024 * 1024;
  return Math.max(1024 * 1024, Math.min(128 * 1024 * 1024, Math.trunc(raw)));
}

function shellExitCode(event: any, rawText: string) {
  if (!event.isError) return 0;
  const match = String(rawText || "").match(/Command exited with code\s+(\d+)/i);
  if (match) return Number(match[1]);
  if (/timed out|timeout/i.test(rawText)) return 124;
  if (/aborted/i.test(rawText)) return 130;
  return 1;
}

function visibleText(event: any) {
  return (event.content || [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
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
      toolStartedAt.delete(String(event.toolCallId || ""));
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
    );

    if (
      ["bash", "powershell"].includes(toolName) &&
      canRecordReusableVerification(commandHint)
    ) {
      const finishedAtMs = Date.now();
      const startedAtMs = toolStartedAt.get(String(event.toolCallId || "")) || finishedAtMs;
      await recordVerification(ctx.cwd, {
        command: "shell",
        args: [commandHint],
        exitCode: shellExitCode(event, shownText || rawText),
        stdout: rawText,
        stderr: event.isError ? rawText : "",
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
      }).catch(() => null);
    }
    toolStartedAt.delete(String(event.toolCallId || ""));

    if (String(process.env.UES_CHILD_TOOL_COMPACTION || "") !== "1") return undefined;
    const maxChars = configuredLimit();
    if (!rawText || rawText.length <= maxChars) return undefined;

    const compacted = await compactReversibleOutput(ctx.cwd, rawText, {
      maxChars,
      kind: `child-${toolName}-output`,
      source: commandHint,
      summary: capture.full
        ? `Full Pi shell output captured from ${capture.sourcePath} before model-visible compaction`
        : "Captured Pi tool output preserved before model-visible compaction",
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
          rawCapture: capture.full ? "full-output-path" : "tool-result",
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
      "Read an exact bounded slice or JSON selector from a UES Evidence Store reference when a compacted tool result says omitted raw evidence is available.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
      start: Type.Optional(Type.Number({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 64000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await getEvidenceSelected(ctx.cwd, params.ref, {
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
