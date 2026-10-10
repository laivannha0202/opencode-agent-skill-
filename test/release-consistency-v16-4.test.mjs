import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkReleaseConsistency } from "../scripts/check-release-consistency.mjs";

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-release-check-"));
  const write = (rel, content) => writeFile(path.join(root, rel), content);
  await mkdir(path.join(root, "global-config", "skills", "s1"), { recursive: true });
  await mkdir(path.join(root, "global-config", "commands"), { recursive: true });
  await mkdir(path.join(root, "global-config", "agents"), { recursive: true });
  await mkdir(path.join(root, "global-config", "plugins", "ues-router"), { recursive: true });
  await mkdir(path.join(root, "pi", "prompts"), { recursive: true });
  await mkdir(path.join(root, "evals"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "lib"), { recursive: true });
  return { root, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeValidTree(write, version) {
  const pkg = {
    version,
    bin: { ues: "bin/ocskill.mjs", ocskill: "bin/ocskill.mjs" },
    scripts: {
      test: "node scripts/run-test-suite.mjs",
      "test:pi": "node scripts/run-test-suite.mjs --concurrency=1 --timeout-ms=90000 test/pi-package.test.mjs",
      "test:node": "node --test",
      "docs:check": "node scripts/check-release-consistency.mjs",
      "release:check-tag": "node scripts/check-release-tag.mjs",
      "eval:pi": "node scripts/eval-pi.mjs",
      eval: "node scripts/eval-pi.mjs",
      "eval:v15": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v15-runtime.test.mjs test/trajectory.test.mjs test/evidence-store-v11.test.mjs test/runtime-events.test.mjs test/v14.3-intelligence.test.mjs test/v14.2-runtime.test.mjs test/pi-package.test.mjs test/execution-contract.test.mjs",
      ci: "npm run integrity && npm run runtime:exports && npm run syntax && npm test && npm run docs:check && npm pack --dry-run && npm run smoke:pi && npm run smoke:package && npm run smoke:packed && npm run accept:fresh-pi",
      integrity: "node scripts/check-source-integrity.mjs",
      "runtime:exports": "node scripts/check-runtime-exports.mjs",
      "smoke:packed": "node scripts/smoke-packed-install.mjs",
      "smoke:pi": "node scripts/smoke-pi-extension.mjs",
      "smoke:package": "node scripts/smoke-package-closure.mjs",
      "accept:fresh-pi": "node scripts/acceptance-fresh-pi.mjs",
      "eval:v15.6": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v15-6-runtime.test.mjs test/v15-5-runtime.test.mjs test/runtime-events.test.mjs test/compaction-resume-guard.test.mjs",
      trial: "node scripts/ues-trial.mjs",
      "optimize:report": "node scripts/runtime-waste-report.mjs",
      "eval:v15.7": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v15-7-runtime.test.mjs test/v15-6-runtime.test.mjs test/v15-5-runtime.test.mjs test/runtime-events.test.mjs test/compaction-resume-guard.test.mjs",
      "trial:gate": "node scripts/ues-trial.mjs --require-promotion",
      "eval:v15.8": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v15-8-runtime.test.mjs test/v15-7-runtime.test.mjs test/benchmark-confidence.test.mjs test/runtime-events.test.mjs test/compaction-resume-guard.test.mjs",
      "eval:skills:v15.9": "node scripts/eval-skills-v15-9.mjs",
      "eval:v15.9": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v15-9-runtime.test.mjs test/v15-8-runtime.test.mjs test/permission-policy.test.mjs test/compaction-resume-guard.test.mjs test/runtime-events.test.mjs && npm run eval:skills:v15.9",
      "eval:v16": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v16-runtime.test.mjs test/fast-verification-gate.test.mjs test/fast-static-verification-v16.test.mjs test/evidence-store-active-work-v16.test.mjs test/fs-cleanup-v16.test.mjs test/execution-capability-v16.test.mjs test/untrusted-output.test.mjs test/model-performance-v12.test.mjs test/compaction-resume-guard.test.mjs test/v15-9-runtime.test.mjs test/browser-reliability-v16-3.test.mjs test/deepseek-web-bridge-v16-3.test.mjs test/v16-3-controller-integration.test.mjs test/v16-3-live-deepseek.test.mjs test/v16-3-manual-auth-wait.test.mjs test/v16-3-live-regressions.test.mjs test/v16-3-auth-ui-detection.test.mjs test/v16-3-deepseek-history-detector.test.mjs",
      "eval:v16.3": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/browser-reliability-v16-3.test.mjs test/deepseek-web-bridge-v16-3.test.mjs test/v16-3-controller-integration.test.mjs test/v16-3-live-deepseek.test.mjs test/v16-3-manual-auth-wait.test.mjs test/v16-3-live-regressions.test.mjs test/v16-3-auth-ui-detection.test.mjs test/v16-3-deepseek-history-detector.test.mjs test/browser-mcp-routing-v14.test.mjs test/browser-runtime-v11.test.mjs test/untrusted-output.test.mjs",
      "eval:v16.3.workers": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v16-3-controller-integration.test.mjs",
      "bench:web-reasoning": "node scripts/bench-web-reasoning-ab.mjs",
      "smoke:deepseek-web": "node scripts/smoke-deepseek-web-v16-3.mjs",
      "release:verify": "npm run ci && npm run eval:v15 && npm run eval:v15.4 && npm run eval:v15.5 && npm run eval:v15.6 && npm run eval:v15.7 && npm run eval:v15.8 && npm run eval:v15.9 && npm run eval:v16 && npm run eval:v16.4 && npm run eval:v16.7 && npm run eval:v16.9 && npm run eval:v16.10 && npm run eval:v16.11 && npm run eval:v16.12 && npm run eval:v16.13 && npm run eval:v16.14 && npm run eval:v16.15 && npm run eval:v16.16 && npm run eval:v16.17",
      "eval:v16.7": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/deepseek-profile-v16-7.test.mjs",
      "eval:v16.9": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/workspace-state-owner-v16-9.test.mjs test/evidence-broker-v16-9.test.mjs test/advisor-admission-v16-9.test.mjs test/advisor-admission-weak-models-v16-9.test.mjs test/advisor-runtime-v16-9.test.mjs test/advisor-dialogue-e2e-v16-9.test.mjs test/web-reasoning-lane-v16-9-equivalence.test.mjs test/web-reasoning-v16-9-production.test.mjs test/source-integrity-v16-9.test.mjs",
      "bench:v16.9": "node scripts/bench-v16-9-admission.mjs",
      "eval:v16.10": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/tool-output-budgeter-v16-10.test.mjs test/context-kernel-v16-10.test.mjs test/repo-intelligence-v16-10.test.mjs test/semantic-tool-router-v16-10.test.mjs test/verification-ladder-v16-10.test.mjs test/efficiency-metrics-v16-10.test.mjs test/source-integrity-v16-10.test.mjs",
      "bench:v16.10": "node scripts/bench-v16-10-capabilities.mjs",
      "eval:v16.11": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/advisor-worker-epoch-v16-11.test.mjs test/browser-transport-v16-11.test.mjs test/advisor-session-manager-v16-11.test.mjs test/advisor-answer-observer-v16-11.test.mjs test/advisor-recovery-v16-11.test.mjs test/advisor-latency-metrics-v16-11.test.mjs test/advisor-resource-hygiene-v16-11.test.mjs test/web-reasoning-v16-11-production.test.mjs test/source-integrity-v16-11.test.mjs",
      "bench:v16.11": "node scripts/bench-v16-11-runtime.mjs",
      "eval:v16.12": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/verification-receipt-cache-v16-12.test.mjs test/task-dag-scheduler-v16-12.test.mjs test/tool-result-reuse-v16-12.test.mjs test/incremental-verification-v16-12.test.mjs test/warm-service-reuse-v16-12.test.mjs test/execution-acceleration-v16-12.test.mjs test/execution-acceleration-wiring-v16-12.test.mjs test/waste-detector-v16-12.test.mjs test/source-integrity-v16-12.test.mjs",
      "bench:v16.12": "node scripts/bench-v16-12-acceleration.mjs",
      "eval:v16.13": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/research-brief-v16-13.test.mjs test/research-provider-router-v16-13.test.mjs test/research-network-policy-v16-13.test.mjs test/research-version-join-v16-13.test.mjs test/research-official-github-v16-13.test.mjs test/research-cache-v16-13.test.mjs test/research-dedup-v16-13.test.mjs test/research-freshness-v16-13.test.mjs test/research-evidence-v16-13.test.mjs test/research-claims-v16-13.test.mjs test/research-speed-path-v16-13.test.mjs test/research-broker-v16-13.test.mjs test/research-production-wiring-v16-13.test.mjs test/source-integrity-v16-13.test.mjs",
      "bench:v16.13": "node scripts/bench-v16-13-research.mjs",
      "eval:v16.14": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/research-cancellation-network-v16-14.test.mjs test/token-economy-v16-14.test.mjs test/source-integrity-v16-14.test.mjs",
      "bench:v16.14": "node scripts/bench-v16-14-economy.mjs",
      "eval:v16.15": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/parallel-execution-policy-v16-15.test.mjs test/execution-conflict-graph-v16-15.test.mjs test/wave-shared-context-v16-15.test.mjs test/integration-transaction-v16-15.test.mjs test/parallel-coding-runtime-v16-15.test.mjs test/parallel-coding-wiring-v16-15.test.mjs test/delegation-safety-v16-15.test.mjs test/source-integrity-v16-15.test.mjs",
      "bench:v16.15": "node scripts/bench-v16-15-parallel-coding.mjs",
      "eval:v16.16": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v16-16-economy.test.mjs test/v16-16-conflict.test.mjs test/v16-16-context.test.mjs test/v16-16-identity.test.mjs test/v16-16-crash-recovery.test.mjs test/v16-16-git-async.test.mjs test/v16-16-runtime.test.mjs test/v16-16-cold-start.test.mjs test/source-integrity-v16-16.test.mjs",
      "bench:v16.16": "node scripts/bench-v16-16-critical-path.mjs",
      "eval:v16.17": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/v16-17-execution-core.test.mjs test/v16-17-execution-plan.test.mjs test/v16-17-prepared-execution.test.mjs test/v16-17-prepared-execution-production.test.mjs test/v16-17-structured-plan-production.test.mjs test/v16-17-structured-plan-smoke.test.mjs test/v16-17-structured-execution-meter.test.mjs test/process-lifecycle-v16-17-1.test.mjs test/service-lifecycle-v16-17-1.test.mjs test/agent-loop-production-abort-v16-17-1.test.mjs test/process-runner.test.mjs test/source-integrity-v16-17.test.mjs",
      "bench:v16.17": "node scripts/bench-v16-17-execution-core.mjs",
      "eval:v16.4": "node scripts/run-test-suite.mjs --concurrency=4 --timeout-ms=90000 test/release-consistency-v16-4.test.mjs test/lazy-runtime-v16-4.test.mjs test/lazy-runtime-production-v16-4.test.mjs test/structural-escalation-v16-4.test.mjs test/fresh-evidence-v16-4.test.mjs test/decision-packet-tiers-v16-4.test.mjs test/verified-cost-learner-v16-4.test.mjs test/web-reasoning-corpus-v16-4.test.mjs test/consult-prep-v16-4.test.mjs test/repo-map-measurements-v16-4.test.mjs test/release-coordinator-v16-4.test.mjs",
      "release:coordinator": "node scripts/release-test-coordinator.mjs",
      "inspect:run": "node scripts/inspect-run.mjs",
      prepublishOnly: "npm run release:verify",
    },
    pi: {
      extensions: ["./pi/extensions/ues.ts"],
      skills: ["./global-config/skills"],
      prompts: ["./pi/prompts/*.md"],
    },
    files: ["bin/ocskill.mjs", "lib/", "global-config/AGENTS.md", "docs/V14.2-TURBO-WEAK-MODEL-RUNTIME.md", "docs/V15-MANAGED-RUNTIME.md", "docs/V15.6-MEASURED-DURABLE-RUNTIME.md", "docs/V15.7-ADAPTIVE-EFFICIENCY-INTELLIGENCE.md", "docs/V15.8-MEASURED-HARDENING.md", "docs/V15.9-ADAPTIVE-AGENT-INTELLIGENCE.md", "docs/V16-DETERMINISTIC-HARDENING.md", "docs/V16.3-BROWSER-WEB-REASONING.md", "docs/V16.4-MEASURED-ADAPTIVE-RUNTIME.md", "docs/V16.7-DEEPSEEK-ACCOUNT-PROFILE-AUTH.md", "docs/V16.10-CONTEXT-INTELLIGENCE-ECONOMY.md", "docs/V16.11-ADVISOR-LIFECYCLE-EVENT-FIRST.md", "docs/V16.12-EXECUTION-ACCELERATION-RUNTIME.md", "docs/V16.13-EXTERNAL-RESEARCH-INTELLIGENCE.md", "docs/V16.14-ULTRA-FAST-TOKEN-ECONOMY.md", "docs/V16.15-SINGLE-SHOT-PARALLEL-CODING.md", "docs/V16.16-CRITICAL-PATH-EXECUTION-COST-RUNTIME.md", "docs/V16.17-EXECUTION-CORE-CONSOLIDATION.md", "lib/browser-profile.mjs", "lib/browser-worker-mode.mjs", "lib/browser-dom-inspect.mjs", "scripts/browser-worker-v16-3.mjs", "scripts/smoke-deepseek-web-v16-3.mjs"],
  };
  const lock = { version, packages: { "": { version, bin: { ues: "bin/ocskill.mjs", ocskill: "bin/ocskill.mjs" } } } };
  await write("package.json", JSON.stringify(pkg));
  await write("package-lock.json", JSON.stringify(lock));
  await write("README.md", `<!-- ues-version: ${version} -->
Pi Agent npm install -g opencode-agent-skill pi package add opencode-agent-skill ues version ues doctor ues status ues trial docs/PI-COMPAT.md npm run eval:v16.5
## What is UES?
## Why UES?
## Highlights
## Architecture
## Quick Start
## Safety Model
## Commands
## Documentation
## Development
## Release Philosophy
## License
`);
  await write("CHANGELOG.md", `# Changelog\n\n## [${version}] - 2026-10-04\n\nnotes\n\n## [16.0.0] - 2026-10-02\n\nnotes\n`);
  await write("evals/routing.json", JSON.stringify({ scenarios: [] }));
  await write("evals/router-triggers.json", JSON.stringify({ cases: [] }));
  const piCompatMarkers = ["# Pi Agent runtime", "Current package runtime:** 16.0.0", "V16 Deterministic Trust & Correctness Hardening", "V15.9 Adaptive Agent Intelligence", "ues_execute", "ues_dispatch", "ues_cli", "manifest is Pi-only", "V14.2 Turbo Weak-Model Runtime", "V15.1 deterministic admission and managed services", "V15.2 Turbo Fast Path", "V15.3 DEEP Speed", "V15.4 ACP-safe child runtime", "V15.5 Per-Leaf Turbo", "V15.6 Fast Planning", "V15.7 Lightweight Sandbox Cleanup", "V15.8 Measured Hardening", "V15.8 Plan Gate Recovery", "V15.9 Runtime Artifact Isolation", "V15.10 Adaptive Stability Runtime", "V15.11 Session Identity Sync", "V15.12 Safe Autopilot + Disk Hygiene", "V15.13 Read-Only Completion Semantics", "V15.14 Deterministic Read-Only Fast Path", "V15.15 Execution Contracts + Phase Gates", "V15.16 Portable Cross-Tool Temp Paths", "V15.17 Zero-Friction Autopilot Admission", "V15.18 Three-Tier Zero-Friction Routing", "V15.19 Finalization Hardening", "ues_service"];
  await write("docs/PI-COMPAT.md", piCompatMarkers.join("\n"));
  await write("docs/OPENCODE-COMPAT.md", "Deprecated compatibility surface\nsupported runtime in this repository is **Pi Agent**\ncanonical runtime lives under `pi/` and `lib/`\ncompatibility shim");
  await write("lib/orchestrator-policy.mjs", `import { x } from "./task-policy.mjs";\nexport const y = x;\n`);
  await write("global-config/plugins/ues-router/policy-runtime.js", `import { x } from "../../../lib/task-policy.mjs";\nexport const y = x;\n`);
  await write("lib/task-policy.mjs", "export function classifyEngineeringTask() {}\nexport function recoveryPolicyForAttempt() {}\n// CONCRETE_DIAGNOSIS diagnosisEvidence\n");
  await write("global-config/skills/s1/SKILL.md", "# s\n");
  for (let i = 0; i < 10; i += 1) await write(`pi/prompts/p${i}.md`, `# p${i}\n`);
}

describe("release consistency version sync (V16.4 slice A)", () => {
  it("passes when package, lock, README and CHANGELOG agree", async () => {
    const { root, write, cleanup } = await fixtureRoot();
    try {
      await writeValidTree(write, "16.3.1");
      const result = checkReleaseConsistency(root);
      assert.equal(result.pass, true, JSON.stringify(result.errors));
      assert.equal(result.version, "16.3.1");
    } finally { await cleanup(); }
  });

  it("fails closed when CHANGELOG latest lags package version", async () => {
    const { root, write, cleanup } = await fixtureRoot();
    try {
      await writeValidTree(write, "16.3.1");
      await write("CHANGELOG.md", "# Changelog\n\n## [16.3.0] - 2026-10-03\n\nnotes\n\n## [16.0.0] - 2026-10-02\n\nnotes\n");
      const result = checkReleaseConsistency(root);
      assert.equal(result.pass, false);
      assert.match(result.errors.join("\n"), /CHANGELOG/);
    } finally { await cleanup(); }
  });

  it("fails closed when package-lock drifts from package.json", async () => {
    const { root, write, cleanup } = await fixtureRoot();
    try {
      await writeValidTree(write, "16.3.1");
      await write("package-lock.json", JSON.stringify({ version: "16.3.0", packages: { "": { version: "16.3.0" } } }));
      const result = checkReleaseConsistency(root);
      assert.equal(result.pass, false);
      assert.match(result.errors.join("\n"), /package-lock/);
    } finally { await cleanup(); }
  });
});
