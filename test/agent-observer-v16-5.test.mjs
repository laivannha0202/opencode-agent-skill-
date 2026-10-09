import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { reasoningDoctor, renderReasoningDoctor, REASONING_READINESS } from "../lib/reasoning-doctor.mjs";
import {
  MAX_LANES,
  PROGRESS_STATE,
  createProgressObserver,
  renderProgress,
  summarizeProgress,
  tickProgress,
  upsertLane,
} from "../lib/agent-progress-observer.mjs";
import { buildMicroSkillContext, phaseToolPriorities } from "../lib/v16-5-runtime.mjs";
import { resetAdvisorLearnerV2ForTests } from "../lib/advisor-benefit-learner-v2.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIVERSE = ["read", "grep", "find", "ls", "bash", "edit", "write", "ues_code", "ues_service", "ues_evidence_get", "ues_tool_search", "playwright_browser_navigate"];

test("V16.5 doctor: is read-only and reports every required row", () => {
  resetAdvisorLearnerV2ForTests();
  const report = reasoningDoctor({ mode: "auto", adapterAvailable: true, profileConfigured: true, authenticated: true });
  assert.equal(report.readOnly, true);
  const keys = report.rows.map((row) => row.key);
  for (const required of ["provider", "mode", "adapter", "profile", "session", "latency", "consultations", "advice", "learner", "packet-tiers", "follow-ups"]) {
    assert.ok(keys.includes(required), required);
  }
});

test("V16.5 doctor: never submits, mutates, or prints credentials", () => {
  const report = reasoningDoctor({ mode: "AUTO", adapterAvailable: false, sessionReady: false, authenticated: false });
  assert.equal(report.safety.submittedPrompt, false);
  assert.equal(report.safety.mutatedState, false);
  assert.equal(report.safety.externalMutation, false);
  assert.equal(report.safety.credentialOutput, false);
  assert.equal(report.safety.cookieOrStorageOutput, false);
  assert.equal(report.authority.consultantOnly, true);
  assert.equal(report.authority.canProducePass, false);
  assert.equal(report.authority.localVerifierIsAuthority, true);
  const text = renderReasoningDoctor(report);
  assert.ok(text.includes("read-only"));
  assert.ok(text.includes("local verifier remains the final correctness authority"));
});

test("V16.5 doctor: unavailable values stay explicitly unavailable", () => {
  const report = reasoningDoctor({});
  const session = report.rows.find((row) => row.key === "session");
  assert.equal(session.readiness, REASONING_READINESS.UNKNOWN);
  assert.ok(session.note.includes("not safely observable"));
  const latency = report.rows.find((row) => row.key === "latency");
  assert.equal(latency.value, "NOT_MEASURED");
  assert.equal(report.verdict, REASONING_READINESS.DEGRADED);

  const blocked = reasoningDoctor({ adapterAvailable: false });
  assert.equal(blocked.verdict, REASONING_READINESS.UNAVAILABLE);
});

test("V16.5 doctor: rendering leaks no secret-looking value", () => {
  const report = reasoningDoctor({ authenticated: true, profile: "deepseek-web-model" });
  const text = renderReasoningDoctor(report);
  assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(text));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(text), "no JWT-shaped value may be rendered");
  const authLine = text.split("\n").find((line) => line.includes("Authenticated")) || "";
  assert.match(authLine, /ready|unavailable|unknown/);
  assert.ok(!authLine.includes("="), "the auth row must carry a state word, not a value");
});

test("V16.5 CLI: `ues doctor --reasoning` is read-only and exits cleanly", () => {
  const out = execFileSync(process.execPath, [path.join(root, "bin", "ocskill.mjs"), "doctor", "--reasoning"], { encoding: "utf8", cwd: root, timeout: 60_000 });
  assert.match(out, /UES reasoning doctor \(read-only\)/);
  assert.match(out, /Specialist advisor roles/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(root, "bin", "ocskill.mjs"), "doctor", "--reasoning", "--json"], { encoding: "utf8", cwd: root, timeout: 60_000 }));
  assert.equal(json.readOnly, true);
  assert.equal(json.release, "v16.5");
});

test("V16.5 observer: renders a bounded fleet view without runtime authority", () => {
  const observer = createProgressObserver({ phase: "delegation" });
  upsertLane(observer, { id: "explore", state: "completed", action: "mapped auth surface" });
  upsertLane(observer, { id: "diagnose", state: "running", action: "reproducing failure" });
  upsertLane(observer, { id: "deepseek", state: "skipped", action: "not needed" });
  upsertLane(observer, { id: "verify", state: "pending" });
  upsertLane(observer, { id: "broken", state: "failed", action: "child exit 1" });
  const view = renderProgress(observer);
  assert.ok(view.text.includes("UES"));
  assert.ok(view.text.includes("explore"));
  assert.ok(view.text.includes("observer-only: this view has no runtime authority"));
  assert.equal(view.summary.completed, 1);
  assert.equal(view.summary.running, 1);
  assert.equal(view.summary.skipped, 1);
  assert.equal(view.summary.pending, 1);
  assert.equal(view.summary.failed, 1);
  assert.deepEqual(view.summary.authority, { runtime: false, verdict: false, permission: false });
  assert.equal(view.summary.chainOfThoughtStored, false);
});

test("V16.5 observer: redacts secret-looking actions and bounds lane count", () => {
  const observer = createProgressObserver({});
  upsertLane(observer, { id: "leak", state: "running", action: "token=abcd1234efgh5678 and api_key: zyxw9876" });
  const view = renderProgress(observer);
  assert.ok(!view.text.includes("abcd1234efgh5678"));
  assert.ok(view.text.includes("[REDACTED]"));

  for (let i = 0; i < MAX_LANES + 10; i += 1) upsertLane(observer, { id: `lane-${i}`, state: "pending" });
  assert.equal(observer.lanes.length, MAX_LANES);
});

test("V16.5 observer: ticking only annotates running lanes", () => {
  const observer = createProgressObserver({ now: 0 });
  upsertLane(observer, { id: "a", state: "running", action: "x", now: 0 });
  upsertLane(observer, { id: "b", state: "completed", action: "y", now: 0 });
  tickProgress(observer, 5_000);
  assert.equal(observer.lanes.find((lane) => lane.id === "a").elapsedMs, 5_000);
  assert.equal(observer.lanes.find((lane) => lane.id === "b").elapsedMs, null);
});

test("V16.5 observer: unknown state degrades to pending", () => {
  const observer = createProgressObserver({});
  upsertLane(observer, { id: "weird", state: "exploded" });
  assert.equal(observer.lanes[0].state, PROGRESS_STATE.PENDING);
  assert.throws(() => upsertLane(observer, { state: "running" }), /requires an id/);
});

test("V16.5 production wiring: the V16.5 runtime module produces a routed capsule", async () => {
  const context = await buildMicroSkillContext({
    task: "Fix the Next.js checkout authorization bug",
    role: "executor",
    taskPolicy: { executionProfile: "standard", risk: "high", maxSkills: 3 },
  });
  assert.equal(context.v16_5.active, true);
  assert.equal(context.selectionMode, "v16.5-registry-routed-capsule");
  assert.ok(context.v16_5.considered >= 40);
  assert.ok(context.v16_5.activated.length >= 1);
  assert.ok(context.v16_5.rawSkillCharsAvoided >= 0);
  assert.ok(context.text.includes("Required constraints"));
});

test("V16.5 production wiring: an unroutable task falls back to the legacy compiler", async () => {
  const context = await buildMicroSkillContext({ task: "zzzz qqqq wwww", role: "executor", taskPolicy: {} });
  assert.equal(context.v16_5.active, false);
  assert.ok(context.v16_5.reason);
  assert.ok(context.text.length > 0);
});

test("V16.5 production wiring: phase tool priority is a narrow priority list, not a surface replacement", () => {
  const trivial = phaseToolPriorities({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE });
  const browser = phaseToolPriorities({ task: "verify the responsive layout in the browser", universe: UNIVERSE });
  assert.deepEqual(trivial.priority, ["read", "grep", "edit", "bash"]);
  assert.ok(browser.priority.includes("playwright_browser_navigate"));
  assert.ok(browser.priority.length > trivial.priority.length);
  for (const row of [trivial, browser]) {
    assert.ok(row.safetyEnforced.length >= 10);
    for (const tool of row.priority) assert.ok(UNIVERSE.includes(tool), tool);
  }
});

test("V16.5 production wiring: micro-skills and phase tool priority are wired", () => {
  const source = readFileSync(path.join(root, "pi", "extensions", "ues.ts"), "utf8");
  assert.ok(source.includes('from "../../lib/v16-5-runtime.mjs"'), "v16-5-runtime.mjs is not imported");
  assert.ok(source.includes("buildMicroSkillContext({"), "micro-skills are not built through V16.5");
  assert.ok(source.includes("phaseToolPriorities({"), "phase tool priority is not wired");
  const phaseCalls = source.split("phaseToolPriorities({").length - 1;
  // Two child-spawn paths (CLI + RPC) plus the V16.16 canonical prewarm
  // predictor, which must mirror the run path's tool universe exactly so a
  // prewarmed worker is actually consumed. The predictor spawns nothing.
  assert.equal(phaseCalls, 3, "child-spawn paths and the prewarm predictor must receive the phase priority");
});

test("V16.5 production wiring: every V16.5 module has a production importer", () => {
  const modules = [
    "skill-registry", "skill-router", "skill-capsule", "tool-surface-v3",
    "subagent-fabric", "verified-handoff", "delegation-safety", "delegation-fleet",
    "deepseek-advisor-roles", "advisor-benefit-learner-v2",
    "reasoning-doctor", "agent-progress-observer", "v16-5-runtime",
  ];
  const extension = readFileSync(path.join(root, "pi", "extensions", "ues.ts"), "utf8");
  const cli = readFileSync(path.join(root, "bin", "ocskill.mjs"), "utf8");
  const runtime = readFileSync(path.join(root, "lib", "v16-5-runtime.mjs"), "utf8");
  const libSources = new Map(
    modules.map((id) => [id, readFileSync(path.join(root, "lib", `${id}.mjs`), "utf8")]),
  );

  // Every module must be reachable from a production entry point:
  // pi/extensions/ues.ts (runtime) or bin/ocskill.mjs (CLI), directly or
  // through lib/v16-5-runtime.mjs.
  const runtimeImports = new Set(
    [...runtime.matchAll(/from "\.\/([a-z0-9-]+)\.mjs"/g)].map((match) => match[1]),
  );
  const unreached = modules.filter((id) => {
    const directExtension = extension.includes(`from "../../lib/${id}.mjs"`);
    const directCli = cli.includes(`from "../lib/${id}.mjs"`);
    return !directExtension && !directCli && !runtimeImports.has(id);
  });
  assert.deepEqual(unreached, [], `unreached V16.5 modules: ${unreached.join(", ")}`);

  // And every module must be imported by something, not be dead code.
  for (const [id, source] of libSources) {
    const exportedNames = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((match) => match[1]);
    assert.ok(exportedNames.length > 0, `${id} exports nothing`);
    const used = [extension, cli, runtime, ...libSources.values()].some(
      (candidate) => candidate !== source && exportedNames.some((name) => candidate.includes(name)),
    );
    assert.ok(used, `${id} has no caller`);
  }

  // Skill contract compilation is the shared source for routing and capsules;
  // the registry is reached transitively so the router cannot drift from it.
  for (const id of ["skill-router", "skill-capsule", "tool-surface-v3"]) {
    assert.ok(runtimeImports.has(id), `v16-5-runtime must import ${id}`);
  }
  assert.ok(libSources.get("skill-router").includes('from "./skill-registry.mjs"'));
  assert.ok(libSources.get("skill-capsule").includes('from "./skill-registry.mjs"'));
});

test("V16.5 production wiring: the Pi extension runs the delegation, handoff and advisor paths", () => {
  const source = readFileSync(path.join(root, "pi", "extensions", "ues.ts"), "utf8");
  for (const symbol of [
    "createDelegationSession",
    "registerChild",
    "finalizeChild",
    "cancelAllChildren",
    "decideDelegation",
    "buildChildContext",
    "assessParallelSafety",
    "createDelegationFleetTelemetry",
    "resolveFleetConcurrency",
    "runDelegationWave",
    "createHandoffCapsule",
    "renderHandoffCapsule",
    "createProgressObserver",
    "selectAdvisorRole",
    "buildAdvisorPacket",
    "advisorWeightV2",
    "recordAdvisorOutcomeV2",
  ]) {
    assert.ok(source.includes(`${symbol}(`), `${symbol} is not called in the runtime`);
  }
  // No-orphan teardown and the bounded handoff must run on the finalize path.
  assert.ok(source.includes("delegation.summary"));
  assert.ok(source.includes("delegation.handoff"));
  assert.ok(source.includes("delegation.decision"));
});
