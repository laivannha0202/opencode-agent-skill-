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
      "destructiveShellRisk",
    ],
  },
  {
    file: "bin/ocskill.mjs",
    minBytes: 60_000,
    startsWith: "#!/usr/bin/env node",
    required: ["task-policy", "work", "store", "memory"],
  },
  {
    file: "lib/task-engine.mjs",
    minBytes: 45_000,
    startsWith: "import ",
    required: ["workspaceFingerprint", "initializeWork", "finalizeWork"],
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
  if (!source.endsWith("\n")) {
    problems.push(`${contract.file}: file does not end with a newline; possible partial write`)
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
