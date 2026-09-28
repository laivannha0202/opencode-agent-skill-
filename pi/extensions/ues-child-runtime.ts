import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { compactReversibleOutput } from "../../lib/performance-fabric.mjs";
import { getEvidenceSelected } from "../../lib/evidence-store.mjs";
import { recordVerification } from "../../lib/verification-broker.mjs";
import { runtimeWorkspaceFingerprint } from "../../lib/workspace-fingerprint.mjs";
import { destructiveShellRisk } from "../../lib/safety.mjs";
import { getUesConfigDir } from "../../lib/runtime-config.mjs";
import { PermissionPolicyStore, permissionRecoveryHint, toolPermissionRequest } from "../../lib/permission-policy.mjs";
import { analyzeUntrustedOutput, renderUntrustedOutputWarning } from "../../lib/untrusted-output.mjs";
import { mcpExecutionPolicy } from "../../lib/mcp-tool-policy.mjs";
import { crossToolTempPathRisk, isLocalEnvPath, localEnvWriteRisk } from "../../lib/execution-contract.mjs";
import {
  canonicalVerificationCommand,
  looksLikeVerificationCommand,
} from "../../lib/verification-command.mjs";
import {
  applyAnchoredFileEdits,
  diagnoseCode,
  lspOperation,
  probeCodeIntelligence,
  readAnchoredCode,
  searchCodeIntelligence,
  shutdownLspPool,
} from "../../lib/code-intelligence/index.mjs";
import { ingestDocument } from "../../lib/document-ingestion.mjs";
import { compactContext, expandContext, searchContext } from "../../lib/reversible-context.mjs";
import {
  looksLikeLongRunningServiceCommand,
  restartService,
  serviceLogs,
  serviceStatus,
  startService,
  stopAllServices,
  stopService,
  waitForService,
} from "../../lib/service-manager.mjs";

const PERMISSION_POLICY = new PermissionPolicyStore(
  path.join(getUesConfigDir(), ".ues", "permissions.json"),
);
const EXTERNAL_TOOL_NAMES = new Set(
  String(process.env.UES_CHILD_EXTERNAL_TOOL_NAMES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const toolExecutionState = new Map<string, {
  startedAt: number;
  workspaceBefore?: string;
  reusableCandidate: boolean;
  canonicalVerification?: { command: string; args: string[]; raw: string } | null;
}>();

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
  // Internal-only extension: the package host may discover this file alongside
  // ues.ts, but only specialist child Pi processes should register its tools.
  // Parent launch paths set UES_CHILD_PROCESS=1 for both CLI and RPC workers.
  if (process.env.UES_CHILD_PROCESS !== "1") return;

  const clearExecutionState = () => toolExecutionState.clear();
  pi.on("session_start", clearExecutionState);
  pi.on("session_shutdown", async (_event, ctx) => {
    clearExecutionState();
    await Promise.all([
      stopAllServices(ctx.cwd).catch(() => []),
      shutdownLspPool(ctx.cwd).catch(() => ({ stopped: 0, remaining: 0 })),
    ]);
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName || "");
    const input: any = event.input || {};
    const permissionRequest = toolPermissionRequest(toolName, input);
    const configuredPermission: any = await PERMISSION_POLICY.evaluate(
      permissionRequest,
      { agent: String(process.env.UES_CHILD_AGENT || "ues-child") },
    ).catch((error) => ({
      configured: true,
      decision: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (configuredPermission.error) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason: "UES permission policy is invalid: " + configuredPermission.error,
      };
    }
    if (configuredPermission?.decision?.effect === "deny") {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason: permissionRecoveryHint(permissionRequest, configuredPermission.decision, { effect: "deny" }),
      };
    }
    if (configuredPermission?.decision?.effect === "ask") {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason: permissionRecoveryHint(permissionRequest, configuredPermission.decision, { effect: "ask" }),
      };
    }
    const localEnvAllowed = String(process.env.UES_CHILD_ALLOW_LOCAL_ENV_WRITE || "") === "1";
    const writeTool = ["edit", "write", "write_file", "apply_patch", "ues_code_edit"].includes(toolName);
    const fileTool = ["read", "edit", "write", "write_file", "apply_patch", "ues_code", "ues_code_edit"].includes(toolName);
    const fileCandidate = String(input.file || input.path || input.filePath || input.target || "");
    const tempPathRisk = crossToolTempPathRisk(fileCandidate);
    if (fileTool && tempPathRisk.risky) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason:
          "UES portable temp-path guard blocked " + fileCandidate +
          ". On Windows, /tmp and /var/tmp may resolve differently between Pi file tools and bash/MSYS. " +
          "For transient transforms, keep creation/read in one shell pipeline; for cross-tool scratch use a repository-local ignored UES path such as .ues-cache/tmp after creating it.",
      };
    }
    if (writeTool && isLocalEnvPath(fileCandidate) && !localEnvAllowed) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason:
          "UES local-env guard blocked a write to " + fileCandidate +
          ". .env/.env.* are local runtime inputs; update an example/template or report NEEDS_USER_ENV unless the user explicitly authorized this local env mutation.",
      };
    }

    if (!["bash", "powershell"].includes(toolName)) return undefined;

    const command = String(input.command || "");
    const envRisk = localEnvWriteRisk(command);
    if (envRisk.risky && !localEnvAllowed) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason:
          "UES local-env guard blocked a shell write to .env/.env.*. Use .env.example/sample/template or report NEEDS_USER_ENV unless explicitly authorized.",
      };
    }
    if (looksLikeLongRunningServiceCommand(command)) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason:
          "UES detected a likely long-running foreground service command. " +
          "Use the ues_service tool (start -> wait-ready/logs -> stop) instead of bash/powershell so the agent does not stall.",
      };
    }
    const risk = destructiveShellRisk(command);
    if (risk.risky) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      return {
        block: true,
        reason:
          `UES child safety blocked ${risk.id || "destructive"} shell operation` +
          (risk.segment ? `: ${risk.segment}` : ""),
      };
    }

    const canonicalVerification = canonicalVerificationCommand(command);
    const reusableCandidate = Boolean(canonicalVerification);
    const workspaceBefore = reusableCandidate
      ? (() => {
          try { return runtimeWorkspaceFingerprint(ctx.cwd); } catch { return undefined; }
        })()
      : undefined;
    toolExecutionState.set(String(event.toolCallId || ""), {
      startedAt: Date.now(),
      workspaceBefore,
      reusableCandidate,
      canonicalVerification,
    });
    if (looksLikeVerificationCommand(command) && (event.input as any)?.timeout == null) {
      (event.input as any).timeout = configuredVerificationTimeout();
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = String(event.toolName || "");
    const shownText = visibleText(event);
    const allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
    const descriptor = allTools.find((tool: any) => String(tool?.name || "") === toolName);
    const externalPolicy = mcpExecutionPolicy(descriptor || { name: toolName });
    const externalBoundary =
      EXTERNAL_TOOL_NAMES.has(toolName) ||
      externalPolicy.externalEvidenceBoundary === true;
    if (externalBoundary && shownText) {
      const analysis = analyzeUntrustedOutput(shownText, { source: toolName });
      if (analysis.flagged) {
        const originalContent = Array.isArray(event.content)
          ? event.content
          : [{ type: "text", text: shownText }];
        return {
          content: [
            { type: "text", text: renderUntrustedOutputWarning(analysis, { source: toolName }) },
            ...originalContent,
          ],
          details: {
            ...(event.details && typeof event.details === "object" ? event.details : {}),
            uesUntrustedOutputBoundary: analysis,
          },
          isError: event.isError,
          usage: event.usage,
        };
      }
    }

    if (!["bash", "powershell", "grep", "find", "ls"].includes(toolName)) {
      return undefined;
    }
    const capture = await capturedText(event, shownText);
    const rawText = capture.text;
    const images = (event.content || []).filter((part: any) => part?.type !== "text");
    const commandHint = String(
      (event.input as any)?.command ||
      (event.input as any)?.pattern ||
      toolName ||
      "tool",
    );

    const executionState = toolExecutionState.get(String(event.toolCallId || ""));
    if (
      ["bash", "powershell"].includes(toolName) &&
      executionState?.reusableCandidate === true &&
      executionState.workspaceBefore &&
      !event.isError
    ) {
      const finishedAtMs = Date.now();
      let workspaceAfter: string | undefined;
      try { workspaceAfter = runtimeWorkspaceFingerprint(ctx.cwd); } catch {}
      if (workspaceAfter && workspaceAfter === executionState.workspaceBefore) {
        const canonical = executionState.canonicalVerification;
        if (canonical) {
          await recordVerification(ctx.cwd, {
            command: canonical.command,
            args: canonical.args,
            exitCode: shellExitCode(event, shownText || rawText),
            stdout: rawText,
            stderr: "",
            startedAt: new Date(executionState.startedAt).toISOString(),
            finishedAt: new Date(finishedAtMs).toISOString(),
            durationMs: Math.max(0, finishedAtMs - executionState.startedAt),
            workspaceBefore: executionState.workspaceBefore,
            workspaceAfter,
          }).catch(() => null);
        }
      }
    }
    toolExecutionState.delete(String(event.toolCallId || ""));

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

  const AnchoredEdit = Type.Object({
    anchor: Type.String({ minLength: 1 }),
    endAnchor: Type.Optional(Type.String({ minLength: 1 })),
    replacement: Type.String(),
  });

  pi.registerTool({
    name: "ues_code",
    label: "UES Code Intelligence",
    description:
      "Bounded code/document/context intelligence for weak models: semantic/AST search, hash-anchored reads, deterministic LSP definition/references/symbols/hover/rename-preview/call hierarchy, diagnostics, optional MarkItDown ingestion, and reversible context recovery.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("search"),
        Type.Literal("read"),
        Type.Literal("diagnostics"),
        Type.Literal("definition"),
        Type.Literal("references"),
        Type.Literal("symbols"),
        Type.Literal("hover"),
        Type.Literal("rename-preview"),
        Type.Literal("incoming-calls"),
        Type.Literal("outgoing-calls"),
        Type.Literal("document"),
        Type.Literal("context-expand"),
        Type.Literal("context-search"),
      ]),
      file: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      structuralPattern: Type.Optional(Type.String()),
      language: Type.Optional(Type.String()),
      startLine: Type.Optional(Type.Number({ minimum: 1 })),
      endLine: Type.Optional(Type.Number({ minimum: 1 })),
      line: Type.Optional(Type.Number({ minimum: 1, description: "1-based source line for LSP operations" })),
      character: Type.Optional(Type.Number({ minimum: 1, description: "1-based source character for LSP operations" })),
      newName: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      includeDeclaration: Type.Optional(Type.Boolean()),
      ref: Type.Optional(Type.String()),
      maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 128000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let result: any;
        if (params.action === "status") {
          result = probeCodeIntelligence(params.file || "");
        } else if (params.action === "search") {
          if (!params.query) throw new Error("ues_code search requires query");
          result = await searchCodeIntelligence(ctx.cwd, params.query, {
            structuralPattern: params.structuralPattern,
            language: params.language,
            file: params.file,
            maxResults: 12,
          });
        } else if (params.action === "read") {
          if (!params.file) throw new Error("ues_code read requires file");
          const startLine = Math.max(1, Math.trunc(Number(params.startLine || 1)));
          const endLine = Math.max(startLine, Math.min(startLine + 399, Math.trunc(Number(params.endLine || startLine + 199))));
          result = await readAnchoredCode(ctx.cwd, params.file, { startLine, endLine });
          return {
            content: [{ type: "text", text: [
              `file: ${result.file}; lines: ${result.startLine}-${result.endLine}/${result.lineCount}; sourceHash: ${result.sourceHash}`,
              "",
              result.text,
            ].join("\n") }],
            details: { action: params.action, file: result.file, sourceHash: result.sourceHash, startLine: result.startLine, endLine: result.endLine },
          };
        } else if (params.action === "diagnostics") {
          if (!params.file) throw new Error("ues_code diagnostics requires file");
          result = await diagnoseCode(ctx.cwd, params.file, { timeoutMs: 5000, maxResults: 80 });
        } else if (["definition", "references", "symbols", "hover", "rename-preview", "incoming-calls", "outgoing-calls"].includes(params.action)) {
          if (!params.file) throw new Error(`ues_code ${params.action} requires file`);
          if (params.action === "rename-preview" && !params.newName) throw new Error("ues_code rename-preview requires newName");
          result = await lspOperation(ctx.cwd, params.file, params.action, {
            line: params.line || 1,
            character: params.character || 1,
            newName: params.newName,
            includeDeclaration: params.includeDeclaration,
            timeoutMs: 7000,
            maxResults: 120,
          });
        } else if (params.action === "document") {
          if (!params.file) throw new Error("ues_code document requires file");
          const document = await ingestDocument(ctx.cwd, params.file, { maxBytes: Math.min(Number(params.maxBytes || 4 * 1024 * 1024), 4 * 1024 * 1024) });
          const block = await compactContext(ctx.cwd, document.markdown, {
            kind: "document-ingestion",
            source: document.file,
            summary: `Normalized document from ${document.provider}`,
          });
          result = {
            provider: document.provider,
            file: document.file,
            bytes: document.bytes,
            optionalDependency: document.optionalDependency,
            contextRef: block.ref,
            originalChars: block.originalChars,
            summary: block.levels.T1,
          };
        } else if (params.action === "context-expand") {
          if (!params.ref) throw new Error("ues_code context-expand requires ref");
          const expanded = await expandContext(ctx.cwd, params.ref, { maxBytes: params.maxBytes || 16000 });
          return {
            content: [{ type: "text", text: expanded.content }],
            details: { action: params.action, ref: expanded.ref, start: expanded.start, returnedBytes: expanded.returnedBytes, truncated: expanded.truncated },
          };
        } else if (params.action === "context-search") {
          if (!params.ref || !params.query) throw new Error("ues_code context-search requires ref and query");
          result = await searchContext(ctx.cwd, params.ref, params.query, { maxBytes: params.maxBytes || 512000, maxMatches: 12 });
        } else {
          throw new Error("unsupported ues_code action");
        }
        const encoded = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text: encoded.length <= 32000 ? encoded : encoded.slice(0, 32000) + "\n...[bounded by ues_code]" }],
          details: { action: params.action, bounded: encoded.length > 32000 },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: params.action },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "ues_code_edit",
    label: "UES Anchored Edit",
    description:
      "Apply fail-closed hash-anchored edits. A stale or mismatched anchor is rejected; re-read with ues_code instead of fuzzy retrying.",
    parameters: Type.Object({
      file: Type.String({ minLength: 1 }),
      edits: Type.Array(AnchoredEdit, { minItems: 1, maxItems: 50 }),
      dryRun: Type.Optional(Type.Boolean()),
      diagnostics: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const edited = await applyAnchoredFileEdits(ctx.cwd, params.file, params.edits, { dryRun: params.dryRun === true });
        const diagnostics = params.diagnostics === true && params.dryRun !== true
          ? await diagnoseCode(ctx.cwd, params.file, { timeoutMs: 3000, maxDiagnostics: 40 }).catch(() => null)
          : null;
        const result = {
          file: edited.file,
          applied: edited.applied,
          dryRun: edited.dryRun,
          sourceHash: edited.sourceHash,
          outputHash: edited.outputHash,
          diagnostics: diagnostics ? {
            available: diagnostics.available,
            provider: diagnostics.provider,
            reason: diagnostics.reason,
            count: diagnostics.diagnostics?.length || 0,
            items: (diagnostics.diagnostics || []).slice(0, 40),
          } : null,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { file: params.file },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "ues_service",
    label: "UES Managed Service",
    description:
      "Manage long-running development servers/watchers without blocking the agent. Use start, wait-ready, status, logs, stop, or restart. For start/restart, command is the executable only (for example node or npm); put every argument in args. Services are bounded to the current workspace/runtime and are cleaned up on session shutdown.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("wait-ready"),
        Type.Literal("status"),
        Type.Literal("logs"),
        Type.Literal("stop"),
        Type.Literal("restart"),
      ]),
      name: Type.String({ minLength: 1, maxLength: 64 }),
      command: Type.Optional(Type.String({ minLength: 1 })),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
      cwd: Type.Optional(Type.String()),
      readyPort: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
      readyHost: Type.Optional(Type.String({ maxLength: 255 })),
      readyLog: Type.Optional(Type.String({ maxLength: 512 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 600000 })),
      lifetimeMs: Type.Optional(Type.Number({ minimum: 10000, maximum: 7200000 })),
      idleTimeoutMs: Type.Optional(Type.Number({ minimum: 5000, maximum: 3600000 })),
      maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 128000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let result: any;
        if (params.action === "start") {
          if (!params.command) throw new Error("ues_service start requires command");
          const riskText = [params.command, ...(params.args || [])].join(" ");
          const risk = destructiveShellRisk(riskText);
          if (risk.risky) throw new Error(`UES service safety blocked ${risk.id || "destructive"} command`);
          result = await startService(ctx.cwd, {
            name: params.name,
            command: params.command,
            args: params.args || [],
            cwd: params.cwd,
            readyPort: params.readyPort,
            readyHost: params.readyHost,
            readyLog: params.readyLog,
            timeoutMs: params.timeoutMs,
            lifetimeMs: params.lifetimeMs,
            idleTimeoutMs: params.idleTimeoutMs,
          });
        } else if (params.action === "wait-ready") {
          result = await waitForService(ctx.cwd, params.name, { timeoutMs: params.timeoutMs });
        } else if (params.action === "status") {
          result = await serviceStatus(ctx.cwd, params.name);
        } else if (params.action === "logs") {
          result = await serviceLogs(ctx.cwd, params.name, { maxChars: params.maxChars, evidence: true });
        } else if (params.action === "stop") {
          result = await stopService(ctx.cwd, params.name, { timeoutMs: params.timeoutMs });
        } else if (params.action === "restart") {
          result = await restartService(ctx.cwd, params.name, {
            timeoutMs: params.timeoutMs,
            lifetimeMs: params.lifetimeMs,
            idleTimeoutMs: params.idleTimeoutMs,
          });
        } else {
          throw new Error("Unknown ues_service action");
        }
        const failed =
          (params.action === "start" || params.action === "wait-ready") && result?.ready !== true;
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
          isError: failed,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: params.action, name: params.name },
          isError: true,
        };
      }
    },
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