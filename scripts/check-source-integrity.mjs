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
      "CHILD_RUNTIME_EXTENSION",
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
    required: ["class RpcWorker", "steerActive", "abortActive", "stopAll"],
  },
  {
    file: "lib/workspace-fingerprint.mjs",
    minBytes: 3_000,
    startsWith: "import ",
    required: ["runtimeWorkspaceFingerprint", "runtimeWorkspaceSnapshot", "changedFiles", "cacheable"],
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