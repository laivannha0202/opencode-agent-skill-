import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { governToolOutput } from "../../lib/tool-output-governor.mjs";
import { pruneStaleFailedToolInputs } from "../../lib/context-pruning.mjs";
import { getEvidenceSelected } from "../../lib/evidence-store.mjs";
import { recordVerification } from "../../lib/verification-broker.mjs";
import { runtimeWorkspaceFingerprint } from "../../lib/workspace-fingerprint.mjs";
import { destructiveShellRisk } from "../../lib/safety.mjs";
import { sensitiveExecutionRisk } from "../../lib/execution-capability.mjs";
import { getUesConfigDir } from "../../lib/runtime-config.mjs";
import { PermissionPolicyStore, permissionRecoveryHint, toolPermissionRequest } from "../../lib/permission-policy.mjs";
import { detectMutationShape } from "../../lib/mutation-shape.mjs";
import { analyzeUntrustedOutput, renderUntrustedOutputWarning } from "../../lib/untrusted-output.mjs";
import { mcpExecutionPolicy } from "../../lib/mcp-tool-policy.mjs";
import { crossToolTempPathRisk, isLocalEnvPath, localEnvWriteRisk } from "../../lib/execution-contract.mjs";
import {
  canonicalVerificationCommand,
  looksLikeVerificationCommand,
} from "../../lib/verification-command.mjs";
import {
  applyAnchoredFileEdits,
  createWriteFeedbackController,
  diagnoseCode,
  extractWrittenFiles,
  lspOperation,
  probeCodeIntelligence,
  readAnchoredCode,
  searchCodeIntelligence,
  shutdownLspPool,
  WRITE_FEEDBACK_TOOLS,
} from "../../lib/code-intelligence/index.mjs";
import { ingestDocument } from "../../lib/document-ingestion.mjs";
import { compactContext, expandContext, searchContext } from "../../lib/reversible-context.mjs";
import { ToolScheduler } from "../../lib/tool-scheduler.mjs";
import { toolConcurrencyContract } from "../../lib/tool-concurrency.mjs";
import { RuntimeHookBus } from "../../lib/runtime-hooks.mjs";
import { analyzeShellCommand, boundedVerificationTimeout } from "../../lib/command-intelligence.mjs";
import {
  DEFERRED_DISPATCHER_TOOL,
  createDeferredHydrationSession,
  describeDeferredTool,
  requestDeferredHydration,
  searchDeferredTools,
} from "../../lib/deferred-tool-hydration.mjs";
import { assertExecutionOwnership } from "../../lib/execution-ownership.mjs";
import { appendRunJournalEvent } from "../../lib/run-journal.mjs";
import { createWriteCheckpoint, finalizeWriteCheckpoint } from "../../lib/write-checkpoints.mjs";
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

const CHILD_RUN_ID = String(process.env.UES_CHILD_RUN_ID || "").trim();
const CHILD_JOURNAL_ROOT = String(process.env.UES_CHILD_JOURNAL_ROOT || "").trim();
const CHILD_RUNTIME_EPOCH_ID = String(process.env.UES_CHILD_RUNTIME_EPOCH_ID || "").trim();
const CHILD_EXECUTION_OWNER_TOKEN = String(process.env.UES_CHILD_EXECUTION_OWNER_TOKEN || "").trim();
const CHILD_EXECUTION_OWNER_SCOPE = String(process.env.UES_CHILD_EXECUTION_OWNER_SCOPE || "").trim();
const CHILD_OWNERSHIP_ROOT = String(process.env.UES_CHILD_OWNERSHIP_ROOT || "").trim();
const TOOL_SCHEDULER = new ToolScheduler({
  maxParallelReads: Number(process.env.UES_CHILD_MAX_PARALLEL_READS || 4),
  maxQueueMs: Number(process.env.UES_CHILD_TOOL_QUEUE_TIMEOUT_MS || 30_000),
});
const RUNTIME_HOOKS = new RuntimeHookBus();
const scheduledToolLeases = new Map<string, any>();
const toolCheckpointState = new Map<string, { checkpointId: string; runId: string }>();

const HOST_SEQUENTIAL_TOOLS = new Set(["bash", "powershell", "edit", "write", "ues_code_edit", "ues_service"]);

function hostManagedLease(owner: string, toolName: string, input: any) {
  return {
    schemaVersion: 1,
    owner,
    toolName,
    contract: toolConcurrencyContract(toolName, input),
    queuedMs: 0,
    hostSequential: true,
    release: () => true,
  };
}

function registerBuiltInExecutionModes(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const definitions = [
    { tool: createReadToolDefinition(cwd), executionMode: "parallel" as const },
    { tool: createGrepToolDefinition(cwd), executionMode: "parallel" as const },
    { tool: createFindToolDefinition(cwd), executionMode: "parallel" as const },
    { tool: createLsToolDefinition(cwd), executionMode: "parallel" as const },
    { tool: createBashToolDefinition(cwd), executionMode: "sequential" as const },
    { tool: createPowerShellToolDefinition(cwd), executionMode: "sequential" as const },
    { tool: createEditToolDefinition(cwd), executionMode: "sequential" as const },
    { tool: createWriteToolDefinition(cwd), executionMode: "sequential" as const },
  ];
  for (const entry of definitions) {
    pi.registerTool({ ...entry.tool, executionMode: entry.executionMode });
  }
}

function schedulerOwner(event: any, toolName = "") {
  return String(event?.toolCallId || "").trim() || (String(toolName || "tool") + ":anonymous");
}

function toolInputHash(input: any) {
  return createHash("sha256").update(JSON.stringify(input || {})).digest("hex");
}

function deferredHydrationEnv() {
  const list = (value: string) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    deferred: list(process.env.UES_CHILD_DEFERRED_TOOLS),
    forbidden: list(process.env.UES_CHILD_HYDRATION_FORBIDDEN),
    role: String(process.env.UES_CHILD_ROLE || ""),
    writer: process.env.UES_CHILD_WRITER === "1",
    max: Math.max(1, Math.min(8, Math.trunc(Number(process.env.UES_CHILD_HYDRATION_MAX || 4)) || 4)),
  };
}

let deferredHydrationSession: any = null;

function resetDeferredHydrationSession() {
  deferredHydrationSession = null;
}

function getDeferredHydrationSession(activeTools: string[] = []) {
  const env = deferredHydrationEnv();
  if (!deferredHydrationSession) {
    deferredHydrationSession = createDeferredHydrationSession({
      deferred: env.deferred,
      advertised: activeTools,
      role: env.role,
      writer: env.writer,
      forbidden: env.forbidden,
      maxHydrations: env.max,
    });
  } else {
    deferredHydrationSession.role = env.role;
    deferredHydrationSession.writer = env.writer;
    deferredHydrationSession.forbidden = [...env.forbidden];
    deferredHydrationSession.maxHydrations = env.max;
    deferredHydrationSession.advertised = [...new Set([...(deferredHydrationSession.advertised || []), ...activeTools])];
  }
  return deferredHydrationSession;
}

async function journalChildEvent(ctx: any, type: string, data: any = {}) {
  if (!CHILD_RUN_ID) return null;
  const root = CHILD_JOURNAL_ROOT || String(ctx?.cwd || process.cwd());
  return appendRunJournalEvent(root, CHILD_RUN_ID, type, data).catch(() => null);
}

async function executionOwnershipBlock(ctx: any, toolName: string, owner: string) {
  if (!CHILD_EXECUTION_OWNER_TOKEN || !CHILD_RUNTIME_EPOCH_ID) return null;
  const root = CHILD_OWNERSHIP_ROOT || CHILD_JOURNAL_ROOT || String(ctx?.cwd || process.cwd());
  const scope = CHILD_EXECUTION_OWNER_SCOPE || CHILD_RUNTIME_EPOCH_ID;
  try {
    await assertExecutionOwnership(
      root,
      scope,
      CHILD_EXECUTION_OWNER_TOKEN,
      { runtimeEpochId: CHILD_RUNTIME_EPOCH_ID },
    );
    return null;
  } catch (error) {
    const code = String((error as any)?.code || "UES_EXECUTION_OWNERSHIP_STALE");
    await journalChildEvent(ctx, "tool.blocked", {
      toolCallId: owner,
      tool: toolName,
      reason: "stale-execution-owner",
      ownershipError: code,
      runtimeEpochId: CHILD_RUNTIME_EPOCH_ID,
    });
    return {
      block: true,
      reason: "UES stale execution owner blocked this tool call (" + code + "). The parent runtime was replaced, expired, or lost ownership; resume through the current UES controller instead of continuing this child.",
    };
  }
}

async function releaseScheduledTool(event: any, ctx: any, type: string) {
  const toolName = String(event?.toolName || "");
  const owner = schedulerOwner(event, toolName);
  const lease = scheduledToolLeases.get(owner);
  if (lease) {
    lease.release?.();
    scheduledToolLeases.delete(owner);
  }
  await RUNTIME_HOOKS.emit("tool.after", {
    toolCallId: owner,
    toolName,
    isError: event?.isError === true,
    queuedMs: Number(lease?.queuedMs || 0),
    contract: lease?.contract || null,
  }, { cwd: ctx?.cwd }).catch(() => null);
  await journalChildEvent(ctx, type, {
    toolCallId: owner,
    tool: toolName,
    queuedMs: Number(lease?.queuedMs || 0),
    concurrencyClass: lease?.contract?.class || null,
    parallelSafe: lease?.contract?.parallelSafe === true,
  });
  return lease || null;
}

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

  // Pi preflights sibling tool calls before executing them. Enforce serial
  // execution through Pi's native per-tool executionMode instead of waiting
  // on a lease inside tool_call, which can deadlock mixed read/write batches.
  registerBuiltInExecutionModes(pi);

  const clearExecutionState = () => {
    toolExecutionState.clear();
    toolCheckpointState.clear();
    scheduledToolLeases.clear();
    TOOL_SCHEDULER.reset("session-boundary");
  };
  pi.on("session_start", clearExecutionState);

  // V16.5 request-local pruning: only stale, large inputs from failed tool calls
  // are reduced. Error results stay intact, signed assistant history is skipped,
  // and cache-first mode preserves the prefix verbatim.
  pi.on("context", async (event) => {
    const pruned = pruneStaleFailedToolInputs(event.messages, {
      cacheMode: String(process.env.UES_CHILD_CACHE_MODE || "neutral"),
      minAgeMessages: 6,
      minInputChars: 2048,
      minSavedChars: 512,
      maxStringChars: 256,
      maxArrayItems: 6,
      maxObjectKeys: 24,
    });
    if (!pruned.changed) return undefined;
    return { messages: pruned.messages };
  });

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
    const owner = schedulerOwner(event, toolName);
    const staleOwnership = await executionOwnershipBlock(ctx, toolName, owner);
    if (staleOwnership) return staleOwnership;
    let schedulerLease: any;
    try {
      if (HOST_SEQUENTIAL_TOOLS.has(toolName)) {
        schedulerLease = hostManagedLease(owner, toolName, input);
      } else {
        schedulerLease = TOOL_SCHEDULER.tryAcquire(owner, toolName, input);
        if (!schedulerLease) {
          const reason = "UES scheduler deferred a conflicting sibling tool call; retry after the current tool results settle";
          await journalChildEvent(ctx, "tool.blocked", {
            toolCallId: owner,
            tool: toolName,
            reason: "scheduler-preflight-conflict",
          });
          return { block: true, reason };
        }
      }
      scheduledToolLeases.set(owner, schedulerLease);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await journalChildEvent(ctx, "tool.blocked", {
        toolCallId: owner,
        tool: toolName,
        reason: "scheduler: " + reason,
      });
      return { block: true, reason };
    }
    const beforeHook = await RUNTIME_HOOKS.emit("tool.before", {
      toolCallId: owner,
      toolName,
      input,
      inputHash: toolInputHash(input),
      queuedMs: Number(schedulerLease.queuedMs || 0),
      contract: schedulerLease.contract,
    }, { cwd: ctx.cwd });
    if (beforeHook.decision === "deny") {
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return { block: true, reason: beforeHook.reason || "UES runtime hook denied tool execution" };
    }
    await journalChildEvent(ctx, "tool.started", {
      toolCallId: owner,
      tool: toolName,
      inputHash: toolInputHash(input),
      queuedMs: Number(schedulerLease.queuedMs || 0),
      concurrencyClass: schedulerLease.contract?.class || null,
      parallelSafe: schedulerLease.contract?.parallelSafe === true,
      policySnapshotId: process.env.UES_CHILD_POLICY_SNAPSHOT_ID || null,
      runtimeEpochId: process.env.UES_CHILD_RUNTIME_EPOCH_ID || null,
    });
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
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason: "UES permission policy is invalid: " + configuredPermission.error,
      };
    }
    if (configuredPermission?.decision?.effect === "deny") {
      toolExecutionState.delete(String(event.toolCallId || ""));
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason: permissionRecoveryHint(permissionRequest, configuredPermission.decision, { effect: "deny" }),
      };
    }
    if (configuredPermission?.decision?.effect === "ask") {
      toolExecutionState.delete(String(event.toolCallId || ""));
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason: permissionRecoveryHint(permissionRequest, configuredPermission.decision, { effect: "ask" }),
      };
    }
    const localEnvAllowed = String(process.env.UES_CHILD_ALLOW_LOCAL_ENV_WRITE || "") === "1";
    const mutation = detectMutationShape(toolName, input);
    const writeTool = mutation.mutation === "yes";
    if (writeTool) {
      const writeHook = await RUNTIME_HOOKS.emit("write.before", {
        toolCallId: owner,
        toolName,
        files: mutation.files || [],
        inputHash: toolInputHash(input),
      }, { cwd: ctx.cwd }).catch(() => ({ decision: "allow" }));
      if (writeHook.decision === "deny") {
        toolExecutionState.delete(String(event.toolCallId || ""));
        await releaseScheduledTool(event, ctx, "tool.blocked");
        return { block: true, reason: writeHook.reason || "UES write lifecycle hook denied mutation" };
      }
    }
    const knownFileTool = ["read", "edit", "write", "write_file", "apply_patch", "ues_code", "ues_code_edit"].includes(toolName);
    const fallbackFile = String(input.file || input.path || input.filePath || input.target || "");
    const fileCandidates = mutation.files.length ? mutation.files : (fallbackFile ? [fallbackFile] : []);
    const fileTool = knownFileTool || writeTool;
    for (const fileCandidate of fileCandidates) {
      const tempPathRisk = crossToolTempPathRisk(fileCandidate);
      if (fileTool && tempPathRisk.risky) {
        toolExecutionState.delete(String(event.toolCallId || ""));
      await releaseScheduledTool(event, ctx, "tool.blocked");
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
      await releaseScheduledTool(event, ctx, "tool.blocked");
        return {
          block: true,
          reason:
            "UES local-env guard blocked a write to " + fileCandidate +
            ". .env/.env.* are local runtime inputs; update an example/template or report NEEDS_USER_ENV unless the user explicitly authorized this local env mutation.",
        };
      }
    }

    const checkpointEnabled = !["0", "false", "off"].includes(
      String(process.env.UES_WRITE_CHECKPOINTS || "1").trim().toLowerCase(),
    );
    if (checkpointEnabled && writeTool && fileCandidates.length) {
      try {
        const checkpoint = await createWriteCheckpoint(ctx.cwd, {
          runId: CHILD_RUN_ID || "child",
          toolCallId: owner,
          tool: toolName,
          files: fileCandidates,
        });
        toolCheckpointState.set(owner, {
          checkpointId: checkpoint.checkpointId,
          runId: checkpoint.runId,
        });
        await journalChildEvent(ctx, "checkpoint.created", {
          toolCallId: owner,
          tool: toolName,
          checkpointId: checkpoint.checkpointId,
          files: checkpoint.files.map((row: any) => row.path),
        });
      } catch {
        // Checkpointing is bounded recovery metadata; it must never block the write.
      }
    }

    if (!["bash", "powershell"].includes(toolName)) return undefined;

    const command = String(input.command || "");
    const envRisk = localEnvWriteRisk(command);
    if (envRisk.risky && !localEnvAllowed) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason:
          "UES local-env guard blocked a shell write to .env/.env.*. Use .env.example/sample/template or report NEEDS_USER_ENV unless explicitly authorized.",
      };
    }
    const commandAnalysis = analyzeShellCommand(command, {
      verificationTimeoutSec: configuredVerificationTimeout(),
    });
    if (looksLikeLongRunningServiceCommand(command) || commandAnalysis.shouldUseManagedService) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      await journalChildEvent(ctx, "command.intelligence", {
        toolCallId: owner,
        tool: toolName,
        finding: "long-running-service-command",
        progressVisibility: commandAnalysis.progressVisibility,
        inputHash: toolInputHash(input),
      });
      await releaseScheduledTool(event, ctx, "tool.blocked");
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
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason:
          `UES child safety blocked ${risk.id || "destructive"} shell operation` +
          (risk.segment ? `: ${risk.segment}` : ""),
      };
    }
    const sensitiveRisk = sensitiveExecutionRisk(command);
    if (sensitiveRisk.risky) {
      toolExecutionState.delete(String(event.toolCallId || ""));
      await journalChildEvent(ctx, "tool.blocked", {
        toolCallId: owner,
        tool: toolName,
        reason: sensitiveRisk.id,
        capabilities: sensitiveRisk.capabilities,
        inputHash: toolInputHash(input),
      });
      await releaseScheduledTool(event, ctx, "tool.blocked");
      return {
        block: true,
        reason:
          "UES V16 capability guard blocked a command that combines credential/secret material with an outbound payload transfer.",
      };
    }

    const verificationLike = commandAnalysis.verificationLike || looksLikeVerificationCommand(command);
    if (verificationLike) {
      const verificationHook = await RUNTIME_HOOKS.emit("verification.before", {
        toolCallId: owner,
        toolName,
        command,
        inputHash: toolInputHash(input),
        progressVisibility: commandAnalysis.progressVisibility,
      }, { cwd: ctx.cwd }).catch(() => ({ decision: "allow" }));
      if (verificationHook.decision === "deny") {
        toolExecutionState.delete(String(event.toolCallId || ""));
        await releaseScheduledTool(event, ctx, "tool.blocked");
        return { block: true, reason: verificationHook.reason || "UES verification lifecycle hook denied command" };
      }
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
    if (commandAnalysis.finding) {
      await journalChildEvent(ctx, "command.intelligence", {
        toolCallId: owner,
        tool: toolName,
        finding: commandAnalysis.finding,
        progressVisibility: commandAnalysis.progressVisibility,
        inputHash: toolInputHash(input),
      });
    }
    if (verificationLike) {
      const configured = configuredVerificationTimeout();
      // A model-provided 90 minute timeout must not bypass the bounded verification
      // policy. Clamp, rather than only filling a missing timeout, so hidden-output
      // pipelines cannot make the agent look hung for an unbounded period.
      const boundedTimeout = boundedVerificationTimeout(
        { ...commandAnalysis, verificationLike: true },
        (event.input as any)?.timeout,
        configured,
      );
      if (boundedTimeout != null) (event.input as any).timeout = boundedTimeout;
    }
    return undefined;
  });

  // V15.3 incremental write intelligence.
  //
  // The child runtime owns a mutation surface Pi does not expose to handlers
  // (`ues_code_edit` runs in-tool, before `tool_result` fires), so it gets its
  // own controller and the same honesty contract. `ues_code_edit` therefore
  // reports code state by default and the old opt-in `diagnostics` parameter is
  // retained only for callers that want the full uncompacted list.
  const childWriteFeedbackEnabled = !["0", "false", "off"].includes(
    String(process.env.UES_POST_WRITE_FEEDBACK || "1").trim().toLowerCase(),
  );
  let childWriteFeedback: any = null;
  let childWriteFeedbackRoot = "";

  const childWriteFeedbackController = (root: string) => {
    if (!childWriteFeedbackEnabled) return null;
    const resolved = root || process.cwd();
    if (childWriteFeedback && childWriteFeedbackRoot === resolved) return childWriteFeedback;
    if (childWriteFeedback) {
      void childWriteFeedback.shutdown?.().catch(() => {});
      childWriteFeedback = null;
    }
    childWriteFeedbackRoot = resolved;
    childWriteFeedback = createWriteFeedbackController({
      root: resolved,
      runDiagnostics: (target: { root: string; relative: string }) =>
        diagnoseCode(target.root, target.relative, {
          timeoutMs: 4_000,
          maxResults: 40,
          persistent: true,
          diagnosticsBudgetPolicy: "post-write-adaptive",
        }),
    });
    return childWriteFeedback;
  };

  // Returns an object to COMPOSE onto the host result, or undefined. Never
  // mutates, never blocks a write, never reports "clean" from an incomplete run.
  async function childPostWriteFeedback(event: any, eventCtx: any, toolName: string) {
    if (!childWriteFeedbackEnabled) return undefined;
    if (event?.isError === true) return undefined;
    const controller = childWriteFeedbackController(String(eventCtx?.cwd || process.cwd()));
    if (!controller) return undefined;
    // Anything a coalesced write is still owed is delivered on ANY tool result,
    // so a child that edits one file repeatedly is never left holding a
    // "pending" with nothing behind it.
    const owed = controller.drain().filter((item: any) => item?.text);
    let feedback: any = null;
    const input = event && typeof event.input === "object" && event.input ? event.input : {};
    const knownWrite = WRITE_FEEDBACK_TOOLS.includes(toolName.toLowerCase());
    const mutation = detectMutationShape(toolName, input);
    if (knownWrite || mutation.mutation === "yes") {
      const files = knownWrite ? extractWrittenFiles(toolName, input) : mutation.files;
      if (files.length) {
        try {
          feedback = files.length > 1
            ? await controller.noteMultiFile({ toolName, files, input })
            : await controller.noteWrite({ toolName, input, relative: files[0] });
        } catch {
          return undefined;
        }
      }
    }
    const blocks = [...owed.map((item: any) => item.text), ...(feedback?.text ? [feedback.text] : [])];
    if (!blocks.length) return undefined;
    const originalContent = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...originalContent, ...blocks.map((text: string) => ({ type: "text", text }))],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        uesPostWrite: {
          delivered: owed.length,
          ...(feedback
            ? {
                file: feedback.file,
                status: feedback.status,
                complete: feedback.complete === true,
                errorCount: feedback.errorCount ?? 0,
                warningCount: feedback.warningCount ?? 0,
              }
            : {}),
        },
      },
      isError: event.isError === true,
      usage: event.usage,
    };
  }

  pi.on("tool_result", async (event, ctx) => {
    const toolName = String(event.toolName || "");
    const owner = schedulerOwner(event, toolName);
    const checkpointState = toolCheckpointState.get(owner);
    if (checkpointState) {
      try {
        const finalized = await finalizeWriteCheckpoint(
          ctx.cwd,
          checkpointState.runId,
          checkpointState.checkpointId,
        );
        if (!event.details || typeof event.details !== "object") (event as any).details = {};
        (event.details as any).uesCheckpoint = {
          checkpointId: finalized.checkpointId,
          runId: finalized.runId,
          restorableFiles: finalized.files.filter((row: any) => row.restorable === true).map((row: any) => row.path),
        };
        await journalChildEvent(ctx, "checkpoint.finalized", {
          toolCallId: owner,
          tool: toolName,
          checkpointId: finalized.checkpointId,
          restorableFiles: finalized.files.filter((row: any) => row.restorable === true).map((row: any) => row.path),
        });
      } catch {
        // Keep the original tool result authoritative if checkpoint finalization fails.
      } finally {
        toolCheckpointState.delete(owner);
      }
    }
    const schedulerLease = await releaseScheduledTool(
      event,
      ctx,
      event.isError === true ? "tool.failed" : "tool.completed",
    );
    const resultInput: any = event && typeof event.input === "object" && event.input ? event.input : {};
    const resultMutation = detectMutationShape(toolName, resultInput);
    if (resultMutation.mutation === "yes") {
      await RUNTIME_HOOKS.emit("write.after", {
        toolCallId: owner,
        toolName,
        files: resultMutation.files || [],
        isError: event.isError === true,
      }, { cwd: ctx.cwd }).catch(() => null);
    }
    const resultCommand = ["bash", "powershell"].includes(toolName)
      ? String(resultInput.command || "")
      : "";
    if (resultCommand && looksLikeVerificationCommand(resultCommand)) {
      await RUNTIME_HOOKS.emit("verification.after", {
        toolCallId: owner,
        toolName,
        command: resultCommand,
        isError: event.isError === true,
        exitCode: shellExitCode(event, visibleText(event)),
      }, { cwd: ctx.cwd }).catch(() => null);
    }
    if (!event.details || typeof event.details !== "object") (event as any).details = {};
    (event.details as any).uesScheduler = {
      queuedMs: Number(schedulerLease?.queuedMs || 0),
      concurrencyClass: schedulerLease?.contract?.class || null,
      parallelSafe: schedulerLease?.contract?.parallelSafe === true,
    };
    const postWrite = await childPostWriteFeedback(event as any, ctx as any, toolName);
    const shownText = visibleText(event);
    const allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
    const descriptor = allTools.find((tool: any) => String(tool?.name || "") === toolName);
    const externalPolicy = mcpExecutionPolicy(descriptor || { name: toolName });
    const externalBoundary =
      EXTERNAL_TOOL_NAMES.has(toolName) ||
      externalPolicy.externalEvidenceBoundary === true;
    let trustBoundaryText = "";
    let trustBoundaryAnalysis: any = null;
    if (externalBoundary && shownText) {
      const analysis = analyzeUntrustedOutput(shownText, {
        source: toolName,
        trustClass: "external-data",
      });
      trustBoundaryAnalysis = analysis;
      trustBoundaryText = renderUntrustedOutputWarning(analysis, {
        source: toolName,
        always: true,
      });
    }

    const compactableTool = ![
      "edit", "write", "ues_code_edit", "ues_evidence_get",
    ].includes(toolName.toLowerCase());
    if (!compactableTool) {
      if (!trustBoundaryText) return postWrite;
      const originalContent = Array.isArray(postWrite?.content)
        ? postWrite.content
        : (Array.isArray(event.content) ? event.content : [{ type: "text", text: shownText }]);
      return {
        content: [{ type: "text", text: trustBoundaryText }, ...originalContent],
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          ...(postWrite?.details && typeof postWrite.details === "object" ? postWrite.details : {}),
          uesUntrustedOutputBoundary: trustBoundaryAnalysis,
        },
        isError: event.isError,
        usage: event.usage,
      };
    }

    const effectiveContent = Array.isArray(postWrite?.content)
      ? postWrite.content
      : (Array.isArray(event.content) ? event.content : []);
    const effectiveShownText = effectiveContent
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    const capture = await capturedText(event, effectiveShownText);
    const rawText = capture.text;
    const images = effectiveContent.filter((part: any) => part?.type !== "text");
    const commandHint = String(
      (event.input as any)?.command ||
      (event.input as any)?.pattern ||
      (event.input as any)?.query ||
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
            exitCode: shellExitCode(event, effectiveShownText || rawText),
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

    if (String(process.env.UES_CHILD_TOOL_COMPACTION || "") !== "1") {
      if (!trustBoundaryText) return postWrite;
      return {
        content: [
          { type: "text", text: trustBoundaryText },
          ...(Array.isArray(postWrite?.content)
            ? postWrite.content
            : (Array.isArray(event.content) ? event.content : [])),
        ],
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          ...(postWrite?.details && typeof postWrite.details === "object" ? postWrite.details : {}),
          uesUntrustedOutputBoundary: trustBoundaryAnalysis,
        },
        isError: event.isError,
        usage: event.usage,
      };
    }
    const phase = looksLikeVerificationCommand(commandHint) ? "verify" : "execute";
    const governed = await governToolOutput(ctx.cwd, rawText, {
      baseMaxChars: configuredLimit(),
      command: commandHint,
      toolName,
      phase,
      cacheMode: String(process.env.UES_CHILD_CACHE_MODE || "neutral"),
      runId: CHILD_RUN_ID || null,
      sessionId: String(process.env.UES_CHILD_RUNTIME_EPOCH_ID || CHILD_RUN_ID || ""),
      failed: event.isError === true,
      kind: `child-${toolName}-output`,
      source: commandHint,
      summary: capture.full
        ? `Full Pi tool output captured from ${capture.sourcePath} before V15.9 model-visible reduction`
        : "Captured Pi tool output preserved before V15.9 model-visible reduction",
    }).catch(() => null);
    if (!governed?.compacted) {
      if (!trustBoundaryText) return postWrite;
      return {
        content: [
          { type: "text", text: trustBoundaryText },
          ...(Array.isArray(postWrite?.content)
            ? postWrite.content
            : (Array.isArray(event.content) ? event.content : [])),
        ],
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          ...(postWrite?.details && typeof postWrite.details === "object" ? postWrite.details : {}),
          uesUntrustedOutputBoundary: trustBoundaryAnalysis,
        },
        isError: event.isError,
        usage: event.usage,
      };
    }

    return {
      content: [
        ...(trustBoundaryText ? [{ type: "text", text: trustBoundaryText }] : []),
        { type: "text", text: governed.text },
        ...images,
      ],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        ...(postWrite?.details && typeof postWrite.details === "object" ? postWrite.details : {}),
        ...(trustBoundaryAnalysis ? { uesUntrustedOutputBoundary: trustBoundaryAnalysis } : {}),
        uesOutputGovernor: {
          schemaVersion: governed.schemaVersion,
          strategy: governed.strategy,
          originalChars: governed.originalChars,
          returnedChars: governed.returnedChars,
          evidenceRef: governed.evidenceRef,
          recoveryTool: "ues_evidence_get",
          adaptiveBudget: { ...governed.adaptive, routedMaxChars: governed.maxChars },
          contentRoute: governed.route,
          cacheMode: governed.cacheMode,
          deltaState: governed.deltaState || null,
          deduplicated: governed.deduplicated === true,
          deltaRatio: governed.deltaRatio ?? null,
          universalBoundary: true,
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
    executionMode: "parallel",
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
        const bounded = encoded.length > 32000;
        let contextRef: string | null = null;
        let visible = encoded;
        if (bounded) {
          const preserved = await compactContext(ctx.cwd, encoded, {
            kind: "ues-code-result",
            source: `ues_code:${params.action}`,
            summary: `Full child code-intelligence result for ${params.action}; preserve exact JSON before model-visible bounding`,
          }).catch(() => null);
          contextRef = preserved?.ref || null;
          const metadataFirst = {
            schemaVersion: result?.schemaVersion || 1,
            action: params.action,
            file: result?.file || null,
            available: result?.available ?? null,
            provider: result?.provider || null,
            operation: result?.operation || null,
            reason: result?.reason || null,
            persistent: result?.persistent ?? null,
            pool: result?.pool || result?.lsp?.persistentPool || null,
            bounded: true,
            originalChars: encoded.length,
            contextRef,
            preview: encoded.slice(0, 22000),
          };
          visible = JSON.stringify(metadataFirst, null, 2) +
            "\n...[full result preserved; use ues_code context-expand with contextRef when more evidence is needed]";
        }
        return {
          content: [{ type: "text", text: visible }],
          details: {
            action: params.action,
            bounded,
            originalChars: encoded.length,
            contextRef,
            provider: result?.provider || null,
            persistent: result?.persistent ?? null,
            pool: result?.pool || result?.lsp?.persistentPool || null,
          },
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
    executionMode: "sequential",
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
        // Post-write intelligence is on by default. The `diagnostics` parameter
        // is kept as the request for the FULL provider payload; the default path
        // returns a compact, honest block that never claims "clean" from an
        // incomplete analysis. A dry run reports nothing because nothing changed.
        let postWrite: any = null;
        if (params.dryRun !== true) {
          const controller = childWriteFeedbackController(String(ctx.cwd || process.cwd()));
          postWrite = controller
            ? await controller.noteWrite({ toolName: "ues_code_edit", input: { file: params.file }, relative: params.file }).catch(() => null)
            : null;
        }
        const diagnostics = params.diagnostics === true && params.dryRun !== true
          ? await diagnoseCode(ctx.cwd, params.file, { timeoutMs: 3000, maxDiagnostics: 40 }).catch(() => null)
          : null;
        const result = {
          file: edited.file,
          applied: edited.applied,
          dryRun: edited.dryRun,
          sourceHash: edited.sourceHash,
          outputHash: edited.outputHash,
          postWrite: postWrite
            ? {
                status: postWrite.status,
                complete: postWrite.complete === true,
                source: postWrite.source,
                errorCount: postWrite.errorCount ?? 0,
                warningCount: postWrite.warningCount ?? 0,
                errors: postWrite.errors || [],
                warnings: postWrite.warnings || [],
                truncated: postWrite.truncated === true,
                durationMs: postWrite.durationMs ?? null,
                poolHit: postWrite.poolHit ?? null,
                ...(postWrite.reason ? { reason: postWrite.reason } : {}),
              }
            : null,
          diagnostics: diagnostics ? {
            available: diagnostics.available,
            provider: diagnostics.provider,
            reason: diagnostics.reason,
            complete: diagnostics.complete === true,
            count: diagnostics.diagnostics?.length || 0,
            items: (diagnostics.diagnostics || []).slice(0, 40),
          } : null,
        };
        const text = postWrite?.text
          ? [JSON.stringify(result, null, 2), postWrite.text].join("\n")
          : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: result };
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
    executionMode: "sequential",
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
          const sensitiveRisk = sensitiveExecutionRisk(riskText);
          if (sensitiveRisk.risky) {
            throw new Error("UES V16 capability guard blocked service start because it combines credential/secret material with an outbound payload transfer");
          }
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
    executionMode: "parallel",
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

  pi.on("session_start", resetDeferredHydrationSession);

  // V16.2 same-attempt deferred-tool hydration. The dispatcher is registered
  // only when the parent economy actually deferred tools for this run. It
  // can only reveal tools from the parent-computed deferred universe (a
  // subset of the per-agent allowlist); execution of a hydrated tool still
  // flows through every existing guard (scheduler, ownership, permission
  // lattice, MCP policy). Activation uses Pi's native setActiveTools in the
  // live session: no restart, no attempt increment.
  if (deferredHydrationEnv().deferred.length > 0) {
    pi.registerTool({
      name: DEFERRED_DISPATCHER_TOOL,
      executionMode: "parallel",
      label: "UES Deferred Tool Search",
      description:
        "Discover and activate a deferred specialist tool in this same session. Use search to find the right deferred tool for a need, then hydrate to activate it. Hydration is bounded per session and writer tools stay unavailable to read-only roles.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("search"), Type.Literal("hydrate")]),
        query: Type.Optional(Type.String()),
        tool: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const env = deferredHydrationEnv();
        let activeTools: string[] = [];
        try {
          activeTools = pi.getActiveTools() || [];
        } catch {
          activeTools = [];
        }
        const session = getDeferredHydrationSession(activeTools);
        try {
          if (params.action === "search") {
            const found = searchDeferredTools({
              query: params.query || "",
              deferred: env.deferred,
              writer: env.writer,
              limit: params.limit || 5,
            });
            session.discoveryCount = Number(session.discoveryCount || 0) + 1;
            await journalChildEvent(ctx, "tool.discovery", {
              query: String(params.query || ""),
              returned: found.returned,
              tools: found.results.map((row) => row.tool),
            });
            const lines = found.results.map((row) => `- ${row.tool} (${row.capability}): ${row.purpose}${row.writerOnly ? " [writer-only]" : ""}`);
            return {
              content: [{
                type: "text",
                text: [
                  `deferred tools matching ${JSON.stringify(String(params.query || ""))}: ${found.returned}/${found.deferredCount} (bounded, deterministic)`,
                  "",
                  ...(lines.length ? lines : ["(no match; try a different need, e.g. 'run tests', 'read file', 'browser check')"]),
                  "",
                  `hydrate with ${DEFERRED_DISPATCHER_TOOL} action=hydrate tool=<name> to activate one in this same session`,
                ].join("\n"),
              }],
              details: { action: "search", ...found },
            };
          }
          if (params.action === "hydrate") {
            const name = String(params.tool || "").trim();
            if (!name || name === DEFERRED_DISPATCHER_TOOL) {
              await journalChildEvent(ctx, "tool.hydration-denied", { tool: name || null, reason: "UNKNOWN_TOOL" });
              return {
                content: [{ type: "text", text: `hydrate denied (UNKNOWN_TOOL): ${name || "(empty)"} is not a deferred tool` }],
                details: { action: "hydrate", granted: false, reason: "UNKNOWN_TOOL" },
                isError: true,
              };
            }
            const decision = requestDeferredHydration(session, name, { writer: env.writer });
            if (decision.granted !== true) {
              await journalChildEvent(ctx, "tool.hydration-denied", { tool: name, reason: decision.reason });
              return {
                content: [{ type: "text", text: `hydrate denied (${decision.reason}): ${name}. ${decision.reason === "READ_ONLY_ROLE" ? "Writer tools are unavailable to this read-only role." : decision.reason === "HYDRATION_BUDGET_EXHAUSTED" ? "Session hydration budget is spent; continue with advertised tools or fail for retry reveal." : "Use search to pick a deferred tool, or continue with the advertised tools."}` }],
                details: { action: "hydrate", granted: false, tool: name, reason: decision.reason },
                isError: true,
              };
            }
            const next = [...new Set([...activeTools, name])];
            try {
              pi.setActiveTools(next);
            } catch (error) {
              await journalChildEvent(ctx, "tool.hydration-denied", { tool: name, reason: "ACTIVATION_FAILED" });
              return {
                content: [{ type: "text", text: `hydrate approved but activation failed for ${name}; continue with advertised tools or fail for retry reveal` }],
                details: { action: "hydrate", granted: false, tool: name, reason: "ACTIVATION_FAILED" },
                isError: true,
              };
            }
            const meta = describeDeferredTool(name);
            await journalChildEvent(ctx, "tool.hydrated", {
              tool: name,
              capability: meta.capability,
              activation: "set-active-tools",
              sameAttempt: true,
              hydratedCount: session.hydrated.length,
            });
            return {
              content: [{
                type: "text",
                text: [
                  `hydrated ${name} in this same session (${meta.capability}: ${meta.purpose})`,
                  `session hydrations: ${session.hydrated.length}/${session.maxHydrations}`,
                  `call ${name} directly now with its normal arguments; all standard guards still apply`,
                ].join("\n"),
              }],
              details: { action: "hydrate", granted: true, tool: name, capability: meta.capability, activation: "set-active-tools", hydrated: [...session.hydrated] },
            };
          }
          return {
            content: [{ type: "text", text: `unsupported ${DEFERRED_DISPATCHER_TOOL} action` }],
            details: { action: params.action },
            isError: true,
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
  }
}