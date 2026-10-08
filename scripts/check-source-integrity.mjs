import { readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CORE = path.join(ROOT, "scripts", "check-source-integrity-core.mjs")

const INTENTIONALLY_DISABLED_WORKFLOW_FAILURES = Object.freeze([
  /^\.github\/workflows\/security\.yml: unreadable \(ENOENT:/,
  /^\.github\/workflows\/publish\.yml: unreadable \(ENOENT:/,
])

// V16.8 lives outside the historical integrity core so disabling GitHub Actions
// never weakens the new production contracts. These checks run locally as part
// of `npm run integrity`; they do not require or create any GitHub workflow.
const V16_8_CONTRACTS = Object.freeze([
  {
    file: "lib/web-decision-barrier-v16-8.mjs",
    minBytes: 12_000,
    required: [
      "phase0FastGrounding",
      "startReadOnlyLocalPrep",
      "discoverAffectedTestsOffThread",
      "evaluateDecisionBarrier",
      "buildExecutorAdvisorCapsule",
      "renderExecutorAdvisorCapsule",
      "deterministicResolutionProof",
      "workspace-mutated-during-consult",
      "V16_8_CAPSULE_MAX_CHARS = 1_200",
      'provider_tokens: "NOT_MEASURED"',
    ],
  },
  {
    file: "lib/web-reasoning-lane-v16-8.mjs",
    minBytes: 10_000,
    required: [
      "createBaseWebReasoningLane",
      "raceAdapterOperation",
      "startReadOnlyLocalPrep",
      "evaluateDecisionBarrier",
      "renderExecutorAdvisorCapsule",
      "web-advisor-hard-deadline",
      "deterministic-local-resolution",
      "sourceMutationAllowed: false",
      "testsExecuted: 0",
    ],
  },
  {
    file: "test/web-decision-barrier-v16-8.test.mjs",
    minBytes: 5_000,
    required: [
      "V16.8 Phase 0 is bounded shaping only",
      "V16.8 read-only prep discovers affected tests without executing them",
      "V16.8 capsule rejects generated targets and never exceeds 1200 chars",
      "V16.8 barrier discards stale generation and workspace mutation",
    ],
  },
  {
    file: "test/web-reasoning-v16-8-production.test.mjs",
    minBytes: 5_000,
    required: [
      "V16.8 production consult injects only a compact validated capsule",
      "V16.8 production barrier discards advice if workspace changes while advisor is running",
      "V16.8 hard deadline aborts the real adapter consult and fences the late result",
    ],
  },
  {
    file: "scripts/bench-v16-8-overlap.mjs",
    minBytes: 5_000,
    required: [
      "sequentialEquivalent",
      "overlapped",
      "sequential_p95_ms",
      "overlapped_p95_ms",
      'provider_tokens_provenance: "NOT_MEASURED"',
    ],
  },
])

export function validateV16_8SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_8_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

// V16.9 lives outside the V16.8 contract set so the two releases are audited
// independently. Each module here is a SINGLE owner for one responsibility the
// V16.8 controller spread across inline closures; the markers below are the
// load-bearing invariants, not cosmetic strings.
const V16_9_CONTRACTS = Object.freeze([
  {
    file: "lib/workspace-state-owner.mjs",
    minBytes: 5_000,
    required: [
      'WORKSPACE_STATE_OWNER_POLICY = "workspace-state-owner-v16-9"',
      "captureWorkspaceStateV2",
      "mutationBetween",
      "fail-closed",
    ],
  },
  {
    file: "lib/prewrite-fence.mjs",
    minBytes: 5_000,
    required: [
      'PREWRITE_FENCE_POLICY = "prewrite-fence-v16-9"',
      "not-applicable",
      "denied",
      "allowed",
    ],
  },
  {
    file: "lib/shared-context-ledger.mjs",
    minBytes: 4_000,
    required: [
      'SHARED_CONTEXT_LEDGER_POLICY = "shared-context-ledger-v16-9"',
      'savedTokensProvenance: "NOT_MEASURED"',
      "planShare",
    ],
  },
  {
    file: "lib/evidence-broker.mjs",
    minBytes: 5_000,
    required: [
      'EVIDENCE_BROKER_POLICY = "evidence-broker-v16-9"',
      "containsUnmaskedSecret",
      "unavailableKinds",
      "never throws",
    ],
  },
  {
    file: "lib/advisor-answer-observer.mjs",
    minBytes: 4_000,
    required: [
      'ADVISOR_ANSWER_OBSERVER_POLICY = "advisor-answer-observer-v16-9"',
      "shouldRecoverAnswerRead",
      "recoverable-read-failure",
    ],
  },
  {
    file: "lib/advisor-capsule.mjs",
    minBytes: 4_000,
    required: [
      'ADVISOR_CAPSULE_POLICY = "advisor-capsule-v16-9"',
      "buildExecutorAdvisorCapsule",
      "renderExecutorAdvisorCapsule",
    ],
  },
  {
    file: "lib/advisor-session-manager.mjs",
    minBytes: 5_000,
    required: [
      'ADVISOR_SESSION_MANAGER_POLICY = "advisor-session-manager-v16-9"',
      "single-writer",
      "maySend",
    ],
  },
  {
    file: "lib/advisor-admission.mjs",
    minBytes: 8_000,
    required: [
      'ADVISOR_ADMISSION_POLICY = "advisor-admission-v16-9"',
      "decideAdmission",
      "ADMISSION_ROUTE",
      "LOCAL_DETERMINISTIC",
      "PI_ONLY",
      "PI_PLUS_ADVISOR",
    ],
  },
  {
    file: "lib/advisor-dialogue-coordinator.mjs",
    minBytes: 5_000,
    required: [
      'ADVISOR_DIALOGUE_POLICY = "advisor-dialogue-coordinator-v16-9"',
      "beginTurn",
      "endTurn",
      "single-flight",
    ],
  },
  {
    file: "lib/execution-coordinator.mjs",
    minBytes: 5_000,
    required: [
      'EXECUTION_COORDINATOR_POLICY = "execution-coordinator-v16-9"',
      "precomputedBarrier",
      "HANDOFF_STATUS",
    ],
  },
  {
    file: "lib/web-reasoning-lane-v16-9.mjs",
    minBytes: 8_000,
    required: [
      'V16_9_LANE_POLICY = "web-reasoning-lane-v16-9"',
      "createV16_8WebReasoningLane",
      "NON_CONSULTING_ROUTES",
      "admissionSkips",
      "prewrite-fence-rejected",
      "No source mutation before the Decision Barrier",
    ],
  },
  {
    file: "test/web-reasoning-lane-v16-9-equivalence.test.mjs",
    minBytes: 5_000,
    required: [
      "no-signal stays a SKIP with the V16.8 escalation reason",
      "MODE OFF stays skipped/web-reasoning-disabled",
      "a concurrent turn is refused (single-flight invariant)",
    ],
  },
  {
    file: "test/web-reasoning-v16-9-production.test.mjs",
    minBytes: 5_000,
    required: [
      "lazy loader hydrates the lifecycle wrapper",
      "reusing the V16.8 barrier",
      "pre-write fence refuses a generated write target",
      "evidence broker is the single owner of the evidence loop in ues.ts",
    ],
  },
  {
    file: "scripts/bench-v16-9-admission.mjs",
    minBytes: 2_000,
    required: [
      "adaptive-admission PRE-GATE",
      "provider consult() calls",
      "measured:",
    ],
  },
  {
    file: "scripts/bench-v16-8-v16-9-representative.mjs",
    minBytes: 8_000,
    required: [
      "V16.9 REPRESENTATIVE V16.8-vs-V16.9 BENCHMARK (classes A-G)",
      "providerTokens: \"NOT_MEASURED\"",
      "A-trivial-deterministic",
      "G-cold-first-task",
    ],
  },
  {
    file: "test/advisor-dialogue-e2e-v16-9.test.mjs",
    minBytes: 8_000,
    required: [
      "V16.9 STATEFUL DIALOGUE E2E",
      "stays in ONE conversation",
      "no duplicate evidence",
      "max-turn ceiling refuses a second follow-up",
      "novelty no-op",
      "epoch bump forces re-send",
    ],
  },
  {
    file: "test/advisor-admission-weak-models-v16-9.test.mjs",
    minBytes: 4_000,
    required: [
      "V16.9 ADMISSION FOR WEAK MODELS",
      "INVARIANT to model self-confidence",
      "deterministic proof found AFTER the advisor started",
    ],
  },
  {
    file: "pi/extensions/ues.ts",
    minBytes: 400_000,
    required: [
      "V16.9 strangler",
      "evidenceBroker.createEvidenceBroker",
      "evidenceBroker.serve(advisorText, {})",
    ],
  },
])

// V16.10 lives outside the historical integrity core too. These contracts pin
// the six new capabilities to their single owners and the honesty laws they
// must not regress (truncation honesty, provably-beneficial compaction,
// measured-only aggregation, advisory-only routing).
const V16_10_CONTRACTS = Object.freeze([
  {
    file: "lib/tool-output-budgeter-v16-10.mjs",
    minBytes: 18_000,
    required: [
      'TOOL_OUTPUT_BUDGETER_POLICY = "tool-output-budgeter-v16-10"',
      "shapeToolOutput",
      "resolveStrategy",
      "assertToolPairIntegrity",
      "omissionNotice",
      "retrieval handle",
    ],
  },
  {
    file: "lib/context-kernel-v16-10.mjs",
    minBytes: 14_000,
    required: [
      'CONTEXT_KERNEL_POLICY = "context-kernel-v16-10"',
      "planContextKernel",
      "applyContextKernel",
      "compactDeterministically",
      'orderingLaw: "deterministic-first-llm-last"',
      "compaction-not-beneficial",
      "pinned-context-exceeds-budget",
    ],
  },
  {
    file: "lib/repo-intelligence-cache-v16-10.mjs",
    minBytes: 9_000,
    required: [
      'REPO_INTEL_CACHE_POLICY = "repo-intelligence-cache-v16-10"',
      "getOrComputeRepoIntel",
      "repoIntelCacheKey",
      "coalesced",
      "schemaVersion",
    ],
  },
  {
    file: "lib/repo-intelligence-v16-10.mjs",
    minBytes: 8_000,
    required: [
      'REPO_INTELLIGENCE_POLICY = "repo-intelligence-v16-10"',
      "buildRepoIntelligence",
      "renderRepoIntelligenceBrief",
      "getOrComputeRepoIntel",
    ],
  },
  {
    file: "lib/semantic-tool-router-v16-10.mjs",
    minBytes: 12_000,
    required: [
      'TOOL_ROUTER_POLICY = "semantic-tool-router-v16-10"',
      "routeToolIntent",
      "mergeRouteIntoPriorities",
      "assertRouteRespectsDenied",
      "discovery-dispatcher",
    ],
  },
  {
    file: "lib/verification-ladder-v16-10.mjs",
    minBytes: 12_000,
    required: [
      'VERIFICATION_LADDER_POLICY = "verification-ladder-v16-10"',
      "planVerificationLadder",
      "runVerificationLadder",
      "passed-insufficient",
      'escalationPolicy: "cheapest-sufficient-rung; escalate-only-when-proven-unavailable"',
    ],
  },
  {
    file: "lib/efficiency-metrics-v16-10.mjs",
    minBytes: 8_000,
    required: [
      'EFFICIENCY_METRICS_POLICY = "efficiency-metrics-v16-10"',
      "buildEfficiencyMetricsV2",
      "honestRatio",
      "verifiedSuccessPer100kTokens",
      'qualityClaim: "NOT_INFERRED_FROM_EFFICIENCY"',
    ],
  },
  {
    file: "test/source-integrity-v16-10.test.mjs",
    minBytes: 800,
    required: [
      "validateV16_10SourceIntegrity",
      "validateV16_9SourceIntegrity",
    ],
  },
  {
    file: "test/verification-ladder-v16-10.test.mjs",
    minBytes: 5_000,
    required: [
      "shutdownLspPool",
      "independent rung is only reachable when declared available",
    ],
  },
  {
    file: "scripts/bench-v16-10-capabilities.mjs",
    minBytes: 3_000,
    required: [
      "V16.10 CAPABILITY BENCHMARK",
      'providerTokens: "NOT_MEASURED"',
      "measured:",
    ],
  },
  {
    file: "pi/extensions/ues.ts",
    minBytes: 400_000,
    required: [
      "semantic-tool-router-v16-10",
      "efficiency-metrics-v16-10",
      "context-kernel-v16-10",
      "repo-intelligence-v16-10",
      "verification-ladder-v16-10",
    ],
  },
  {
    file: "lib/tool-output-governor.mjs",
    minBytes: 12_000,
    required: [
      "tool-output-budgeter-v16-10",
      "shapeToolOutput",
      "resolveStrategy",
    ],
  },
])

// V16.11 lives outside every prior contract set so each release is audited
// independently. V16.11 makes ONE owner responsible for the advisor lifecycle
// and adds an event-first answer channel with a bounded poll fallback. The
// markers below pin the load-bearing invariants (single ownership, event-first
// honesty, bounded recovery, proven Windows cleanup) and NEVER weaken a prior
// release: the V16.9 session-manager contract above still pins the byte-stable
// policy id and the single-writer law.
const V16_11_CONTRACTS = Object.freeze([
  {
    file: "lib/advisor-lifecycle-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'ADVISOR_LIFECYCLE_POLICY = "advisor-lifecycle-v16-11"',
      "createLifecycleIdentity",
      "advanceWorkerEpoch",
      "advanceProfileEpoch",
      "beginAdvisorRun",
      "openConversation",
      "classifyStaleness",
      "evaluateConversationReuse",
      "conversationReuseKey",
    ],
  },
  {
    file: "lib/browser-transport-v16-11.mjs",
    minBytes: 7_000,
    required: [
      'BROWSER_TRANSPORT_V2_POLICY = "browser-transport-v16-11"',
      "BROWSER_TRANSPORT_V2_VERSION = 2",
      "decodeTransportMessage",
      "encodeRequestV2",
      "negotiateProtocol",
      "canUseEventChannel",
      "createCoalescingEventSink",
      "answer.stable",
      "answer.completed",
      "worker.exited",
    ],
  },
  {
    file: "lib/advisor-event-bridge-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'ADVISOR_EVENT_BRIDGE_POLICY = "advisor-event-bridge-v16-11"',
      "createAdvisorEventBridge",
      "OBSERVATION_CHANNEL",
      "EVENT_THEN_POLL",
      "eventSilenceMs",
      "poll_fallback",
    ],
  },
  {
    file: "lib/advisor-recovery-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'ADVISOR_RECOVERY_POLICY = "advisor-recovery-v16-11"',
      "planRecovery",
      "createSubmitGuard",
      "classifyFailureKind",
      "RECOVERY_MAX_TOTAL_ATTEMPTS = 3",
      "RECOVERY_MAX_PER_KIND = 2",
      "submit-in-flight",
      "RECOVERY_ACTION",
    ],
  },
  {
    file: "lib/advisor-latency-metrics-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'ADVISOR_LATENCY_METRICS_POLICY = "advisor-latency-metrics-v16-11"',
      "buildLatencySample",
      "aggregateLatencyMetrics",
      "SIMULATED_ONLY",
      "byWorkerState",
      "byChannel",
      'claimStatus:',
    ],
  },
  {
    file: "lib/windows-resource-hygiene-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'WINDOWS_HYGIENE_POLICY = "windows-hygiene-v16-11"',
      "proveBrowserResourceCleanup",
      "detectRetainedResources",
      "HYGIENE_VERDICT",
      "terminateProcessTree",
      "KILL_PROCESS_TREE",
    ],
  },
  {
    file: "lib/advisor-runtime-v16-11.mjs",
    minBytes: 6_000,
    required: [
      'ADVISOR_RUNTIME_POLICY = "advisor-runtime-v16-11"',
      "createAdvisorRuntime",
      "beginConsult",
      "observeEvent",
      "claimSubmit",
      "onFailure",
      "shutdown",
    ],
  },
  {
    file: "lib/lazy-runtime.mjs",
    minBytes: 5_000,
    required: [
      'ADVISOR_RUNTIME: "advisor-runtime-v16-11"',
      'ADVISOR_SESSION_MANAGER: "advisor-session-manager"',
      'ADVISOR_LIFECYCLE: "advisor-lifecycle-v16-11"',
      "ADVISOR_LIFECYCLE: Object.freeze([",
    ],
  },
  {
    file: "pi/extensions/ues.ts",
    minBytes: 400_000,
    required: [
      "V16.11 lifecycle ownership",
      "ACTIVE_ADVISOR_RUNTIMES",
      "getAdvisorRuntime",
      "acquireManagedBrowserWorkerLease",
      "managedBrowserWorkerHealth",
      "spawnManagedBrowserWorker",
      'hydrateLazy(LAZY_RUNTIME_MODULES.ADVISOR_RUNTIME)',
    ],
  },
  {
    file: "test/source-integrity-v16-11.test.mjs",
    minBytes: 800,
    required: [
      "validateV16_11SourceIntegrity",
      "validateV16_10SourceIntegrity",
    ],
  },
  {
    file: "test/advisor-session-manager-v16-11.test.mjs",
    minBytes: 4_000,
    required: [
      "the module keeps its stable policy id and evolves the schema",
      "acquiring a worker advances the worker epoch",
      "a stale event from an old worker epoch is discarded and counted",
    ],
  },
  {
    file: "test/browser-transport-v16-11.test.mjs",
    minBytes: 4_000,
    required: [
      "a malformed message fails closed without throwing",
      "a legacy V1 response (no type) decodes as a response",
    ],
  },
  {
    file: "test/advisor-recovery-v16-11.test.mjs",
    minBytes: 4_000,
    required: [
      "duplicate",
      "bounded",
      "epoch",
    ],
  },
  {
    file: "test/advisor-resource-hygiene-v16-11.test.mjs",
    minBytes: 3_000,
    required: [
      "cleanup",
      "retained",
    ],
  },
  {
    file: "test/web-reasoning-v16-11-production.test.mjs",
    minBytes: 5_000,
    required: [
      "the production module is reachable through the lazy stack",
      "the first consult is COLD, the second is WARM and reuses the worker",
      "a stale event from an old worker epoch is refused before the bridge",
      "re-claiming an in-flight consult submit is refused",
    ],
  },
  {
    file: "scripts/bench-v16-11-runtime.mjs",
    minBytes: 3_000,
    required: [
      "V16.11 ADVISOR RUNTIME BENCHMARK",
      'PROVIDER_TOKENS = "NOT_MEASURED"',
      "measured:",
    ],
  },
])

// V16.12 Execution Acceleration Runtime contracts. Each module owns exactly one
// question; the markers below pin the LAW each module is built on so a future
// edit cannot silently weaken it.
const V16_12_CONTRACTS = Object.freeze([
  {
    file: "lib/verification-receipt-cache-v16-12.mjs",
    minBytes: 12_000,
    required: [
      'RECEIPT_CACHE_POLICY = "verification-receipt-cache-v16-12"',
      "receiptProvesPass",
      "findReusableReceipt",
      "recordReceipt",
      "finalReleaseMode",
      "ATOMIC_RETRY_CODES",
      "atomicWriteJson",
      'REUSED: "REUSED"',
    ],
  },
  {
    file: "lib/task-dag-scheduler-v16-12.mjs",
    minBytes: 12_000,
    required: [
      'TASK_DAG_POLICY = "task-dag-scheduler-v16-12"',
      "planTaskDag",
      "runTaskDag",
      "NODE_EFFECT",
      "NODE_STATUS",
      'SKIPPED: "skipped"',
      'STALE: "stale"',
      "DAG_DEADLOCK",
      "WRITES ARE SERIALIZED",
    ],
  },
  {
    file: "lib/tool-result-reuse-v16-12.mjs",
    minBytes: 10_000,
    required: [
      'TOOL_RESULT_REUSE_POLICY = "tool-result-reuse-v16-12"',
      "withResultReuse",
      "toolResultKey",
      "TOOL_RESULT_PROVENANCE",
      'CACHE_HIT: "CACHE_HIT"',
      "spillBytes",
    ],
  },
  {
    file: "lib/incremental-verification-v16-12.mjs",
    minBytes: 8_000,
    required: [
      'INCREMENTAL_VERIFICATION_POLICY = "incremental-verification-v16-12"',
      "planIncrementalVerification",
      "classifyTaskShape",
      "TASK_SHAPE",
      "FAST_PATH",
      "planVerificationLadder",
      "buildFailureDelta",
    ],
  },
  {
    file: "lib/warm-service-reuse-v16-12.mjs",
    minBytes: 8_000,
    required: [
      'WARM_SERVICE_POLICY = "warm-service-reuse-v16-12"',
      "createWarmServiceRegistry",
      "WARM_SERVICE_KIND",
      "LAZY, NEVER ALWAYS-ON",
      "SINGLE-FLIGHT",
      "alwaysOn: false",
    ],
  },
  {
    file: "lib/execution-acceleration-v16-12.mjs",
    minBytes: 8_000,
    required: [
      'EXECUTION_ACCELERATION_POLICY = "execution-acceleration-v16-12"',
      "planExecutionAcceleration",
      "createAccelerationContext",
      "runAcceleratedDag",
      "assertFreshGateAllowed",
      "freshGatesRequired",
      "THE RELEASE PATH IS SACRED",
    ],
  },
  {
    file: "lib/waste-detector-v16-12.mjs",
    minBytes: 8_000,
    required: [
      'WASTE_DETECTOR_POLICY = "waste-detector-v16-12"',
      "createWasteDetector",
      "createWallTimeAttribution",
      "wallAttributionToEfficiencyEvents",
      "WALL_CATEGORY",
      "WASTE_OPERATION",
    ],
  },
  {
    file: "test/source-integrity-v16-12.test.mjs",
    minBytes: 800,
    required: [
      "validateV16_12SourceIntegrity",
      "validateV16_11SourceIntegrity",
    ],
  },
  {
    file: "test/verification-receipt-cache-v16-12.test.mjs",
    minBytes: 5_000,
    required: [
      "final-release mode refuses ALL reuse",
      "a corrupt entry is treated as a MISS",
      "atomicWriteJson retries Windows EBUSY/EPERM",
    ],
  },
  {
    file: "test/task-dag-scheduler-v16-12.test.mjs",
    minBytes: 5_000,
    required: [
      "a stale-generation result is discarded and settles (regression)",
      "the deadlock guard reports DAG_DEADLOCK instead of spinning",
      "a SOURCE_WRITE never overlaps anything",
    ],
  },
  {
    file: "test/tool-result-reuse-v16-12.test.mjs",
    minBytes: 5_000,
    required: [
      "a changed content hash is a MISS",
      "a large result spills to the evidence store",
      "concurrent identical operations are coalesced",
    ],
  },
  {
    file: "test/incremental-verification-v16-12.test.mjs",
    minBytes: 5_000,
    required: [
      "the planner never invents its own rung ordering",
      "final release targets the full suite, requires release verify",
      "recommendNextTarget escalates after a failure",
    ],
  },
  {
    file: "test/warm-service-reuse-v16-12.test.mjs",
    minBytes: 5_000,
    required: [
      "a registry with no use starts NO service",
      "a warm handle that fails its health check is evicted",
      "concurrent cold starts for the same key are single-flight",
    ],
  },
  {
    file: "test/execution-acceleration-v16-12.test.mjs",
    minBytes: 4_000,
    required: [
      "the release path is sacred",
      "assertFreshGateAllowed refuses a cached receipt",
      "createAccelerationContext attributes wall time",
    ],
  },
  {
    file: "test/execution-acceleration-wiring-v16-12.test.mjs",
    minBytes: 2_000,
    required: [
      "the four acceleration modules are registered as lazy",
      "a boot hydrates NO acceleration module",
      "resolves acceleration ONLY through the lazy registry",
    ],
  },
  {
    file: "test/waste-detector-v16-12.test.mjs",
    minBytes: 4_000,
    required: [
      "the efficiency bridge produces observations Metrics V2 can aggregate",
      "an unobserved category reads NOT_MEASURED",
      "the same operation at the same workspace generation is waste",
    ],
  },
  {
    file: "scripts/bench-v16-12-acceleration.mjs",
    minBytes: 4_000,
    required: [
      "V16.12 EXECUTION ACCELERATION BENCHMARK",
      'PROVIDER_TOKENS = "NOT_MEASURED"',
      'synthetic: true',
      "measured:",
    ],
  },
  {
    file: "pi/extensions/ues.ts",
    minBytes: 400_000,
    required: [
      "execution-acceleration-v16-12",
      "verification-receipt-cache-v16-12",
      "tool-result-reuse-v16-12",
      "waste-detector-v16-12",
    ],
  },
])

export function validateV16_12SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_12_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

// V16.13 External Research Intelligence contracts. Each module owns exactly
// one policy question; the markers pin the speed-first laws (zero-research
// fast path, deterministic admission, primary-sources-first, browser last
// resort, DeepSeek not default, SEARCH != EVIDENCE, EvidenceStore body
// ownership, Metrics V2 single authority, Decision Barrier, PI_ONLY zero
// egress) so a future edit cannot silently weaken them.
const V16_13_CONTRACTS = Object.freeze([
  {
    file: "lib/research-brief-v16-13.mjs",
    minBytes: 8000,
    required: [
      'RESEARCH_BRIEF_POLICY = "research-brief-v16-13"',
      "decideResearchAdmission",
      "buildResearchBrief",
      "isSufficientEvidence",
      "model-confidence-alone-insufficient",
      "RESEARCH_CAPSULE_MAX_CHARS = 8_000",
    ],
  },
  {
    file: "lib/research-provider-router-v16-13.mjs",
    minBytes: 4000,
    required: [
      'RESEARCH_ROUTER_POLICY = "research-provider-router-v16-13"',
      "routeProviders",
      "selectFallback",
      "primary-sources-first",
    ],
  },
  {
    file: "lib/external-research-broker-v16-13.mjs",
    minBytes: 12000,
    required: [
      'RESEARCH_BROKER_POLICY = "external-research-broker-v16-13"',
      "createExternalResearchBroker",
      "trackClaims",
      "resolveContradictions",
      "buildResearchCapsule",
      "checkDecisionBarrier",
      'providerTokens: "NOT_MEASURED"',
      "NOT_AVAILABLE",
    ],
  },
  {
    file: "lib/research-network-policy-v16-13.mjs",
    minBytes: 5000,
    required: [
      'RESEARCH_NETWORK_POLICY = "research-network-policy-v16-13"',
      "canonicalizeUrl",
      "checkUrlAllowed",
      "validateRedirectChain",
      "classifyOutboundQuery",
      "BLOCKED_POLICY:private-host",
    ],
  },
  {
    file: "lib/research-version-join-v16-13.mjs",
    minBytes: 2000,
    required: [
      'RESEARCH_VERSION_JOIN_POLICY = "research-version-join-v16-13"',
      "joinVersions",
      "compareVersions",
      "recommendationTargetsInstalledByDefault",
    ],
  },
  {
    file: "lib/research-provider-official-v16-13.mjs",
    minBytes: 3000,
    required: [
      'OFFICIAL_PROVIDER_POLICY = "research-provider-official-v16-13"',
      "resolveOfficialTarget",
      "exact-version-docs-unavailable-recorded",
    ],
  },
  {
    file: "lib/research-provider-github-v16-13.mjs",
    minBytes: 3000,
    required: [
      'GITHUB_PROVIDER_POLICY = "research-provider-github-v16-13"',
      "authHeadersForHost",
      "UES_RESEARCH_GITHUB_TOKEN",
      "RATE_LIMIT",
    ],
  },
  {
    file: "lib/research-page-fetch-v16-13.mjs",
    minBytes: 5000,
    required: [
      'PAGE_FETCH_POLICY = "research-page-fetch-v16-13"',
      "fetchAndNormalize",
      "toCandidateSource",
      "CANDIDATE_SOURCE",
      "EXTERNAL_EVIDENCE",
      "instructionAuthority",
    ],
  },
  {
    file: "lib/research-cache-helper-v16-13.mjs",
    minBytes: 4000,
    required: [
      'RESEARCH_CACHE_POLICY = "research-cache-helper-v16-13"',
      "researchCacheKey",
      "readResearchCache",
      "FORCE_FRESH_BYPASS",
    ],
  },
  {
    file: "lib/lazy-runtime.mjs",
    minBytes: 5000,
    required: [
      'RESEARCH_BROKER: "external-research-broker-v16-13"',
      "RESEARCH: Object.freeze([",
    ],
  },
  {
    file: "pi/extensions/ues.ts",
    minBytes: 400_000,
    required: [
      "external-research-broker-v16-13",
      "research-brief-v16-13",
      "hydrateLazy(LAZY_RUNTIME_MODULES.RESEARCH_BROKER)",
    ],
  },
  {
    file: "test/source-integrity-v16-13.test.mjs",
    minBytes: 800,
    required: [
      "validateV16_13SourceIntegrity",
      "validateV16_12SourceIntegrity",
    ],
  },
  {
    file: "test/research-brief-v16-13.test.mjs",
    minBytes: 2000,
    required: [
      "model confidence alone cannot trigger research",
    ],
  },
  {
    file: "test/research-broker-v16-13.test.mjs",
    minBytes: 2000,
    required: [
      "official source alone sufficient",
    ],
  },
  {
    file: "scripts/bench-v16-13-research.mjs",
    minBytes: 4000,
    required: [
      "V16.13 EXTERNAL RESEARCH BENCHMARK",
      'PROVIDER_TOKENS = "NOT_MEASURED"',
      "SIMULATED_ONLY",
    ],
  },
])

export function validateV16_13SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_13_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

// V16.14 Ultra-Fast Token Economy + Runtime Correctness Hardening contracts.
//
// V16.14 hardens V16.13's research path in place and adds ONE new single owner
// (the bounded HTTPS transport). The markers below pin the load-bearing
// invariants: true cancellation, resolved-address SSRF validation, connection
// pinning, manual bounded redirects, credential stripping, content-hash claim
// binding, conditional revalidation, byte-vs-char honesty, MEASURED-only
// provider tokens, the DeepSeek economy gate, and the hard char budget the
// context kernel / tool-output budgeter must never exceed. Every prior
// V16.8-V16.13 contract is untouched: this set is additive.
const V16_14_CONTRACTS = Object.freeze([
  {
    file: "lib/research-transport-v16-14.mjs",
    minBytes: 8_000,
    required: [
      'RESEARCH_TRANSPORT_POLICY = "research-transport-v16-14"',
      "createBoundedExternalTransport",
      "toFetchLike",
      "filterForwardHeaders",
      "SENSITIVE_FORWARD_HEADERS",
      "pinnedAddresses",
      "BLOCKED_POLICY:redirect-limit-exceeded",
      "BLOCKED_POLICY:credential-redirect",
      "ABORT_ERR",
      "PUBLIC HTTPS ONLY",
      "TRUE CANCELLATION",
      "BOUNDED BYTES",
    ],
  },
  {
    file: "lib/research-network-policy-v16-13.mjs",
    minBytes: 8_000,
    required: [
      "checkResolvedAddress",
      "checkResolvedAddresses",
      "isPrivateIpv4",
      "isPrivateIpv6Host",
      "resolved-private-address",
      "unresolvable-host",
      "0x64400000",
      "0x7f000000",
    ],
  },
  {
    file: "lib/external-research-broker-v16-13.mjs",
    minBytes: 16_000,
    required: [
      'RESEARCH_BROKER_POLICY = "external-research-broker-v16-13"',
      "HIGH_RISK_CLAIM_CLASSES",
      "planDeepSeekEconomy",
      "normalizeProviderUsage",
      "buildResearchProvenance",
      "PROVIDER_TOKEN_PROVENANCE",
      "empty-synthesis-input",
      "binding: \"sourceId-only\"",
      "withTimeoutAbort",
      "linkedController",
      "cancelledProviderCalls",
      'providerTokens: "NOT_MEASURED"',
      "utf8Bytes",
      "research-waste:${signal}",
    ],
  },
  {
    file: "lib/research-page-fetch-v16-13.mjs",
    minBytes: 8_000,
    required: [
      'PAGE_FETCH_POLICY = "research-page-fetch-v16-13"',
      "researchHeadersForUrl",
      "fetchAndNormalize",
      "excerptHash",
      "notModified",
      "conditionalHeaders",
      "getDefaultFetchLike",
    ],
  },
  {
    file: "lib/research-cache-helper-v16-13.mjs",
    minBytes: 6_000,
    required: [
      "revalidationHeadersFor",
      "reuseDecisionFor",
      "touchResearchCache",
      "revalidatedAt",
    ],
  },
  {
    file: "lib/research-version-join-v16-13.mjs",
    minBytes: 2_000,
    required: [
      "sourceMatchesInstalledVersion",
      "upgradeRequested",
      "latestSource",
      "versionMatchedSource",
    ],
  },
  {
    file: "lib/tool-output-budgeter-v16-10.mjs",
    minBytes: 18_000,
    required: [
      "HARD BUDGET GUARANTEE",
      "budget-enforced after strategy shaping",
      "noticeOverheadChars",
    ],
  },
  {
    file: "lib/context-kernel-v16-10.mjs",
    minBytes: 14_000,
    required: [
      "fallbackId",
      "segment-${createHash",
      "Shrink deterministically until the shaped text fits",
    ],
  },
  {
    file: "lib/lazy-runtime.mjs",
    minBytes: 5_000,
    required: [
      'RESEARCH_TRANSPORT: "research-transport-v16-14"',
      "LAZY_RUNTIME_MODULES.RESEARCH_TRANSPORT",
    ],
  },
  {
    file: "test/source-integrity-v16-14.test.mjs",
    minBytes: 800,
    required: [
      "validateV16_14SourceIntegrity",
      "validateV16_13SourceIntegrity",
    ],
  },
  {
    file: "test/research-cancellation-network-v16-14.test.mjs",
    minBytes: 5_000,
    required: [
      "a hostname resolving to a private address is blocked (DNS SSRF)",
      "a public -> private redirect is BLOCKED_POLICY",
      "an abort signal destroys the in-flight socket (no orphan request)",
      "the token is stripped across a redirect off GitHub",
    ],
  },
  {
    file: "test/token-economy-v16-14.test.mjs",
    minBytes: 5_000,
    required: [
      "bytes are measured as UTF-8 bytes, not as JS string length",
      "provider tokens are MEASURED only from real provider usage",
      "a char-derived token count is ESTIMATED, never MEASURED",
      "the bounded context shaper honors its budget INCLUDING the notice",
      "the tool-output shaper honors its budget INCLUDING the notice",
      "a noticed waste signal reaches the metrics producer path as an observation, not a verdict",
    ],
  },
  {
    file: "scripts/bench-v16-14-economy.mjs",
    minBytes: 4_000,
    required: [
      "V16.14 ULTRA-FAST TOKEN ECONOMY BENCHMARK",
      'PROVIDER_TOKENS = "NOT_MEASURED"',
      'claimStatus: "SIMULATED_ONLY"',
      "tokenColumnsProvenance",
      "summedSpeedupClaim",
    ],
  },
  {
    file: "docs/V16.14-ULTRA-FAST-TOKEN-ECONOMY.md",
    minBytes: 2_000,
    required: [
      "V16.14",
      "NOT_MEASURED",
      "Cancellation",
    ],
  },
])

export function validateV16_14SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_14_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

export function validateV16_11SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_11_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

export function validateV16_10SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_10_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

export function validateV16_9SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_9_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

export function extractCriticalIntegrityFailures(text = "") {
  const source = String(text || "")
  const marker = "Critical UES source-integrity validation failed:"
  const start = source.indexOf(marker)
  if (start < 0) return []
  const tail = source.slice(start + marker.length)
  const diffBoundary = tail.indexOf("+ actual - expected")
  const stackBoundary = tail.indexOf("\n    at ")
  const boundaries = [diffBoundary, stackBoundary].filter((value) => value >= 0)
  const end = boundaries.length ? Math.min(...boundaries) : Math.min(tail.length, 8_000)
  return tail
    .slice(0, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

export function onlyIntentionallyDisabledWorkflowFailures(failures = []) {
  const rows = Array.isArray(failures) ? failures.map(String) : []
  if (rows.length !== INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.length) return false
  return INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.every((pattern) =>
    rows.some((row) => pattern.test(row)),
  ) && rows.every((row) =>
    INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.some((pattern) => pattern.test(row)),
  )
}

export function runSourceIntegrity() {
  const v16_8Failures = validateV16_8SourceIntegrity(ROOT)
  if (v16_8Failures.length) {
    process.stderr.write("V16.8 source-integrity validation failed:\n")
    for (const failure of v16_8Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_9Failures = validateV16_9SourceIntegrity(ROOT)
  if (v16_9Failures.length) {
    process.stderr.write("V16.9 source-integrity validation failed:\n")
    for (const failure of v16_9Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_10Failures = validateV16_10SourceIntegrity(ROOT)
  if (v16_10Failures.length) {
    process.stderr.write("V16.10 source-integrity validation failed:\n")
    for (const failure of v16_10Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_11Failures = validateV16_11SourceIntegrity(ROOT)
  if (v16_11Failures.length) {
    process.stderr.write("V16.11 source-integrity validation failed:\n")
    for (const failure of v16_11Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_12Failures = validateV16_12SourceIntegrity(ROOT)
  if (v16_12Failures.length) {
    process.stderr.write("V16.12 source-integrity validation failed:\n")
    for (const failure of v16_12Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_13Failures = validateV16_13SourceIntegrity(ROOT)
  if (v16_13Failures.length) {
    process.stderr.write("V16.13 source-integrity validation failed:\n")
    for (const failure of v16_13Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const v16_14Failures = validateV16_14SourceIntegrity(ROOT)
  if (v16_14Failures.length) {
    process.stderr.write("V16.14 source-integrity validation failed:\n")
    for (const failure of v16_14Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const run = spawnSync(process.execPath, [CORE], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  })
  const stdout = String(run.stdout || "")
  const stderr = String(run.stderr || "")
  if (run.status === 0) {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    return 0
  }

  const failures = extractCriticalIntegrityFailures(`${stdout}\n${stderr}`)
  if (onlyIntentionallyDisabledWorkflowFailures(failures)) {
    console.log(
      "Source integrity PASS: all production source contracts passed; GitHub Actions workflow contracts are intentionally disabled.",
    )
    return 0
  }

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return Number.isInteger(run.status) && run.status !== 0 ? run.status : 1
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(runSourceIntegrity())
