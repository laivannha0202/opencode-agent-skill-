import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const CONTRACTS = [
  {
    file: "pi/extensions/ues.ts",
    minBytes: 80_000,
    startsWith: "import { spawn }",
    required: [
      'name: "ues_cli"',
      'name: "ues_execute"',
      'name: "ues_dispatch"',
      "runRoutedAgent",
      "PiRpcWorkerPool",
      "McpHealthTracker",
      "MCP_HEALTH",
      "auditCompletion",
      'pi.registerCommand("ues-run"',
      'name: "ues_service"',
      "looksLikeLongRunningServiceCommand",
      "ues_controller_direct",
      "CHILD_RUNTIME_EXTENSION",
      "isAbortedRun",
      "abortedResponse",
      'reason: "aborted"',
    ],
  },
  {
    file: "pi/extensions/ues-child-runtime.ts",
    minBytes: 6_000,
    startsWith: 'import type { ExtensionAPI }',
    required: [
      'pi.on("tool_call"',
      'pi.on("tool_result"',
      'name: "ues_evidence_get"',
      'name: "ues_code"',
      'name: "ues_code_edit"',
      'name: "ues_service"',
      'process.env.UES_CHILD_PROCESS !== "1"',
      "looksLikeLongRunningServiceCommand",
      "stopAllServices",
      "applyAnchoredFileEdits",
      "diagnoseCode",
      "recordVerification",
      "canonicalVerificationCommand",
      "destructiveShellRisk",
    ],
  },
  {
    file: "bin/ocskill.mjs",
    minBytes: 74_000,
    startsWith: "#!/usr/bin/env node",
    required: [
      'case "context-pack"',
      'case "work"',
      'case "task-policy"',
      'case "sandbox"',
      'case "store"',
      'case "capabilities"',
      'case "capability-fabric"',
      'case "hierarchy"',
      'case "memory"',
      'case "visual"',
      'case "browser"',
      'case "workflow-plan"',
      'case "dashboard"',
      'case "models"',
      'case "update"',
      'case "remove"',
      'case "help"',
      "getEvidenceSelected",
    ],
  },
  {
    file: "lib/task-engine.mjs",
    minBytes: 45_000,
    startsWith: "import ",
    required: ["workspaceFingerprint", "initWork", "finalizeWork"],
  },
  {
    file: "lib/model-performance.mjs",
    minBytes: 5_500,
    startsWith: "export const MODEL_TASK_CLASSES",
    required: [
      "recordPerformanceOutcome",
      "wilsonLowerBound",
      "rerankCapabilitySelection",
    ],
  },
  {
    file: "lib/evidence-store.mjs",
    minBytes: 7_500,
    startsWith: "import ",
    required: ["putEvidence", "getEvidence", "getEvidenceSelected"],
  },
  {
    file: "lib/process-supervisor.mjs",
    minBytes: 4_500,
    startsWith: "import ",
    required: ["terminateProcessTree", "runSupervisedProcess", "drainTimeoutMs"],
  },
  {
    file: "lib/pi-rpc-pool.mjs",
    minBytes: 8_000,
    startsWith: "import ",
    required: ["class RpcWorker", "steerActive", "abortActive", "abortTransport", "activeAbort", "uesRpcPhase", "stopAll"],
  },
  {
    file: "lib/workspace-fingerprint.mjs",
    minBytes: 3_000,
    startsWith: "import ",
    required: ["runtimeWorkspaceFingerprint", "runtimeWorkspaceSnapshot", "changedFiles", "cacheable", "untrackedContentDigest", "untracked-total-too-large"],
  },
  {
    file: "lib/skill-compiler.mjs",
    minBytes: 4_000,
    startsWith: "import ",
    required: ["compileSkillContext", "clearSkillCompilerCache", "COMPILED_SKILL_CACHE.set", "return result"],
  },
  {
    file: "lib/verification-command.mjs",
    minBytes: 2_000,
    startsWith: "export const VERIFICATION_COMMAND_RE",
    required: [
      "looksLikeVerificationCommand",
      "canRecordReusableVerification",
      "canonicalVerificationCommand",
    ],
  },
  {
    file: "lib/verification-broker.mjs",
    minBytes: 8_000,
    startsWith: "import ",
    required: [
      "recordVerification",
      "findReusableVerification",
      "listReusableVerification",
      "withCrossProcessCacheLock",
      "entryMatchesKey",
      "freshEnough",
    ],
  },
  {
    file: "test/v14.2-runtime.test.mjs",
    minBytes: 30_000,
    startsWith: 'import assert from "node:assert/strict"',
    required: [
      'test("V14.2 hot-path helper exports are live"',
      'test("external RPC abort rejects the active run instead of settling normally"',
      'test("verification broker preserves concurrent receipts in one workspace"',
      'test("RPC pool never evicts an active worker when an idle-capacity limit is exceeded"',
    ],
  },

  {
    file: "lib/code-intelligence/edit-anchor.mjs",
    minBytes: 2_500,
    startsWith: "import ",
    required: ["anchoredLines", "applyAnchoredEdits", "UES_STALE_ANCHOR"],
  },
  {
    file: "lib/code-intelligence/index.mjs",
    minBytes: 4_000,
    startsWith: "import ",
    required: ["readAnchoredCode", "applyAnchoredFileEdits", "searchCodeIntelligence", "diagnoseCode"],
  },
  {
    file: "lib/code-intelligence/lsp-provider.mjs",
    minBytes: 5_000,
    startsWith: "import ",
    required: ["diagnoseCode", "lspProviderStatus", "publishDiagnostics"],
  },
  {
    file: "lib/completion-auditor.mjs",
    minBytes: 2_500,
    startsWith: "function text",
    required: ["auditCompletion", "fresh-behavioral-receipt-missing", "missing-report-section"],
  },
  {
    file: "lib/document-ingestion.mjs",
    minBytes: 3_000,
    startsWith: "import ",
    required: ["ingestDocument", "documentIngestionSupport", "UES_MARKITDOWN_UNAVAILABLE"],
  },
  {
    file: "lib/reversible-context.mjs",
    minBytes: 2_500,
    startsWith: "import ",
    required: ["compactContext", "expandContext", "searchContext"],
  },
  {
    file: "lib/mcp-tool-policy.mjs",
    minBytes: 1_000,
    startsWith: "function firstObject",
    required: ["normalizeMcpAnnotations", "mcpExecutionPolicy", 'trust: "hint-only"'],
  },
  {
    file: "lib/mcp-health.mjs",
    minBytes: 4_000,
    startsWith: "const TRANSIENT_ERROR",
    required: ["McpHealthTracker", "mcpReconnectAdvice", "transient-idempotent-failure", "cooldownUntil"],
  },
  {
    file: "test/v14.3-intelligence.test.mjs",
    minBytes: 5_000,
    startsWith: 'import test from "node:test"',
    required: ["hash anchored edits fail closed", "completion auditor rejects narrative PASS", "verified memory snapshots ignore retrieval/touch noise", "MCP health only recommends reconnect"],
  },

  {
    file: "lib/service-manager.mjs",
    minBytes: 8_000,
    startsWith: "import ",
    required: [
      "startService",
      "waitForService",
      "serviceStatus",
      "serviceLogs",
      "stopService",
      "restartService",
      "stopAllServices",
      "looksLikeLongRunningServiceCommand",
      "terminateProcessTree",
      'kind: "service-log"',
    ],
  },
  {
    file: "test/v15-runtime.test.mjs",
    minBytes: 3_000,
    startsWith: 'import assert from "node:assert/strict"',
    required: [
      "V15 managed service starts, proves readiness, captures evidence and stops",
      "V15 deterministic controller admission and service tool are wired into Pi",
      "UES_EVAL_DIRECT_TELEMETRY",
      "ues_controller_direct",
    ],
  },

  {
    file: "lib/affected-tests.mjs",
    minBytes: 7_500,
    startsWith: "import ",
    required: ["resolveAffectedTests", "clearAffectedTestCache", "AFFECTED_TEST_CACHE.set", "return result"],
  },
]

const problems = []
for (const contract of CONTRACTS) {
  const absolute = path.join(root, ...contract.file.split("/"))
  let source = ""
  let bytes = 0
  try {
    bytes = statSync(absolute).size
    source = readFileSync(absolute, "utf8")
  } catch (error) {
    problems.push(`${contract.file}: unreadable (${error?.message || error})`)
    continue
  }

  if (bytes < contract.minBytes) {
    problems.push(`${contract.file}: ${bytes} bytes < required ${contract.minBytes}; possible fragment overwrite`)
  }
  if (!source.startsWith(contract.startsWith)) {
    problems.push(`${contract.file}: source prefix mismatch; possible missing file head`)
  }
  for (const marker of contract.required) {
    if (!source.includes(marker)) {
      problems.push(`${contract.file}: missing integrity marker ${JSON.stringify(marker)}`)
    }
  }
}

assert.deepEqual(
  problems,
  [],
  "Critical UES source-integrity validation failed:\n" + problems.map((item) => "- " + item).join("\n"),
)

console.log(`Source integrity passed for ${CONTRACTS.length} critical runtime files.`)