// Incremental write-intelligence benchmark (V15.3 Phase 1).
//
//   node scripts/bench-write-feedback.mjs [--json] [--live]
//
// Baseline question: after a successful edit, how much does the agent learn, and
// what does it cost?
//
// Pre-patch, the answer is "nothing": a successful edit returns no code signal at
// all, and the model has to spend a whole tool round-trip calling
// `ues_code diagnostics` before it learns whether it just broke the file. This
// benchmark records that manual cost so the automatic post-write path can be
// held to it instead of being declared "fast".
//
// It drives the real anchored-edit primitive and the real diagnostics path. A
// deterministic in-process provider is used by default so the receipt is
// reproducible on any machine; `--live` runs the real pooled language server.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile } from "node:fs/promises"
import { applyAnchoredFileEdits, diagnoseCode, shutdownLspPool } from "../lib/code-intelligence/index.mjs"
import { resetLspPoolMetrics } from "../lib/code-intelligence/lsp-pool.mjs"
import { resetDiagnosticsBudgetHistory } from "../lib/code-intelligence/diagnostics-budget.mjs"
import { argValue, hasFlag, optionalModule, printReceipt, round, timed, withTempDir } from "./bench-common.mjs"

const MOCK_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "mock-lsp-server.mjs")

async function editFile(root, relative, marker) {
  const { readAnchoredCode } = await import("../lib/code-intelligence/index.mjs")
  const read = await readAnchoredCode(root, relative, { startLine: 1, endLine: 4 })
  return applyAnchoredFileEdits(root, relative, [{
    anchor: read.rows[0].anchor,
    endAnchor: read.rows[0].anchor,
    replacement: `export const ${marker} = 1\n`,
  }])
}

async function run(root) {
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  await writeFile(path.join(root, "src", "order.ts"), "export const orderTotal = 1\n")

  const writeFeedback = await optionalModule("../lib/code-intelligence/write-feedback.mjs")
  const live = hasFlag("--live")

  const cases = []

  // --- what the model must do today: edit, then ask again ---------------
  resetDiagnosticsBudgetHistory()
  const manual = await timed(async () => {
    await editFile(root, "src/order.ts", "firstRevision")
    const result = await diagnoseCode(root, "src/order.ts", { timeoutMs: 5_000, maxResults: 40, persistent: true })
    return result
  })
  cases.push({
    case: live ? "edit-then-manual-diagnostics-live" : "edit-then-manual-diagnostics",
    mode: "manual-tool-roundtrip",
    ms: manual.ms,
    complete: manual.value?.complete === true,
    diagnostics: manual.value?.diagnostics?.length || 0,
    poolHit: manual.value?.pool?.poolHit ?? null,
    persistent: manual.value?.persistent ?? null,
    provider: manual.value?.provider || null,
  })

  // --- the automatic path -------------------------------------------------
  if (writeFeedback.ok) {
    // A real language server takes longer to answer than the coalescing window,
    // so driving the burst through it would measure latency, not coalescing.
    // The default provider is in-process and deterministic; `--live` uses the
    // pooled server for the latency numbers instead.
    let providerCalls = 0
    const controller = writeFeedback.module.createWriteFeedbackController({
      root,
      runDiagnostics: live
        ? (target) => diagnoseCode(target.root, target.relative, {
            timeoutMs: 5_000,
            maxResults: 40,
            persistent: true,
          })
        : async (target) => {
            providerCalls += 1
            return {
              complete: true,
              diagnostics: [],
              diagnosticsSource: "lsp-publish",
              pool: { poolHit: providerCalls > 1, sessionId: "deterministic-session" },
              fingerprint: target.fingerprint,
            }
          },
    })

    const first = await timed(async () => {
      await editFile(root, "src/order.ts", "autoRevision")
      return controller.noteWrite({ relative: "src/order.ts", toolName: "edit" })
    })
    cases.push({
      case: live ? "post-write-first-live" : "post-write-first",
      mode: "automatic",
      ms: first.ms,
      providerCalls,
      feedback: first.value?.status ?? null,
      complete: first.value?.complete === true,
      errors: first.value?.errorCount ?? null,
      warnings: first.value?.warningCount ?? null,
      durationMs: first.value?.durationMs ?? null,
      poolHit: first.value?.poolHit ?? null,
    })

    // Three rapid edits to the same file must not produce three checks.
    await controller.flush()
    const before = writeFeedback.module.writeFeedbackMetrics()
    const burstStart = Date.now()
    for (const marker of ["burstA", "burstB", "burstC"]) {
      await editFile(root, "src/order.ts", marker)
      await controller.noteWrite({ relative: "src/order.ts", toolName: "edit" })
    }
    const burst = await controller.flush()
    const after = writeFeedback.module.writeFeedbackMetrics()
    cases.push({
      case: "post-write-burst-of-three",
      mode: "automatic",
      ms: round(Date.now() - burstStart),
      checksDuringBurst: after.postWriteChecks - before.postWriteChecks,
      coalescedDuringBurst: after.postWriteCoalesced - before.postWriteCoalesced,
      providerCalls,
      finalStatus: burst?.last?.status ?? null,
      finalComplete: burst?.last?.complete === true,
    })

    cases.push({ case: "post-write-telemetry", mode: "telemetry", ...writeFeedback.module.writeFeedbackMetrics() })
    await controller.shutdown()
  } else {
    cases.push({
      case: "post-write-automatic",
      mode: "automatic",
      available: false,
      reason: writeFeedback.error,
    })
  }

  // --- unsupported extension must stay cheap and honest -------------------
  await writeFile(path.join(root, "notes.unknownext"), "hello\n")
  const unsupported = await timed(() => diagnoseCode(root, "notes.unknownext", { timeoutMs: 1_000, maxResults: 10 }))
  cases.push({
    case: "unsupported-extension",
    ms: unsupported.ms,
    available: unsupported.value?.available === true,
    reason: unsupported.value?.reason || null,
  })

  resetLspPoolMetrics()
  await shutdownLspPool().catch(() => {})

  return {
    schemaVersion: 1,
    kind: "ues-write-feedback-benchmark",
    node: process.version,
    live,
    provider: live ? "typescript-language-server" : "in-process-deterministic",
    mockServer: live ? null : path.relative(path.dirname(MOCK_SERVER), MOCK_SERVER).replaceAll("\\", "/"),
    cases,
  }
}

const receipt = await withTempDir("write-feedback", run)
printReceipt(receipt)
