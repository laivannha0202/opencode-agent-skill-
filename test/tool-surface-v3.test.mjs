import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFERRED_DISPATCHER_TOOL,
} from "../lib/deferred-tool-hydration.mjs";
import {
  HYDRATION_DENY_REASON,
  SAFETY_CAPABILITIES,
  compilePhaseToolSurface,
  finalizeToolSurfaceTelemetry,
  hydrateCapability,
  predictCapabilities,
  summarizeHydration,
} from "../lib/tool-surface-v3.mjs";

const UNIVERSE = [
  "read", "grep", "find", "ls", "bash", "powershell", "edit", "write",
  "ues_code", "ues_code_edit", "ues_service", "ues_evidence_get",
  DEFERRED_DISPATCHER_TOOL,
  "playwright_browser_navigate", "playwright_browser_snapshot",
];

test("V16.5 tool surface: a trivial code fix gets a minimal surface", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.equal(surface.phase, "implement");
  for (const tool of ["read", "grep", "edit", "bash"]) assert.ok(surface.advertised.includes(tool), tool);
  for (const tool of ["playwright_browser_navigate", "ues_service", "ues_evidence_get", "write"]) {
    assert.ok(!surface.advertised.includes(tool), `${tool} must not be advertised for a trivial fix`);
  }
  assert.ok(surface.toolSurfaceChars > 0);
  assert.equal(surface.telemetry.toolsAvailable, UNIVERSE.length);
  assert.equal(surface.telemetry.toolsAdvertised, surface.advertised.length);
});

test("V16.5 tool surface: a browser task adds the browser capability", () => {
  const surface = compilePhaseToolSurface({ task: "verify the responsive layout in the browser with a screenshot", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.ok(surface.advertised.includes("playwright_browser_navigate"), surface.advertised.join(","));
  const trivial = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.ok(surface.advertised.length > trivial.advertised.length);
});

test("V16.5 tool surface: a database task adds code intelligence for schema navigation", () => {
  const db = compilePhaseToolSurface({ task: "write the database migration for the orders table and check the query plan", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.ok(db.advertised.includes("ues_code"), db.advertised.join(","));
  assert.ok(db.capabilities.includes("database-access"));
  const trivial = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.ok(!trivial.advertised.includes("ues_code"));
});

test("V16.5 tool surface: safety policy stays enforced even when the tool is hidden", () => {
  const surface = compilePhaseToolSurface({ task: "fix the authorization check", universe: UNIVERSE, denied: ["bash", "write"], maxAdvertisedTools: 8 });
  assert.ok(!surface.advertised.includes("bash"), "denied tool must not be advertised");
  assert.ok(!surface.advertised.includes("write"));
  assert.deepEqual(surface.safetyEnforced, [...SAFETY_CAPABILITIES]);
  assert.equal(surface.hiddenToolsRemainPolicyChecked, true);
  assert.equal(surface.sideEffectHydrationRequiresPolicyCheck, true);
  for (const capability of ["permission-lattice", "verification-gate", "evidence-store", "secret-redaction", "dirty-work-guard", "execution-ownership"]) {
    assert.ok(surface.safetyEnforced.includes(capability), capability);
  }
});

test("V16.5 tool surface: a missing capability hydrates exactly once on evidence", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  const first = hydrateCapability(surface, { capability: "browser-automation", evidence: "the page must be verified visually" });
  assert.equal(first.granted, true);
  assert.equal(first.reason, "HYDRATED_ON_EVIDENCE");
  assert.equal(first.tool, "playwright_browser_navigate");
  assert.equal(first.permanentToolLoss, false);
  assert.equal(first.permissionRemoved, false);
  assert.ok(surface.advertised.includes("playwright_browser_navigate"));

  const second = hydrateCapability(surface, { capability: "browser-automation", evidence: "again" });
  assert.equal(second.granted, false);
  assert.equal(second.reason, HYDRATION_DENY_REASON.ALREADY_HYDRATED);

  const summary = summarizeHydration(surface);
  assert.equal(summary.requests, 2);
  assert.equal(summary.granted, 1);
  assert.equal(summary.rejected, 1);
});

test("V16.5 tool surface: a denied capability stays denied", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, denied: ["write"], maxAdvertisedTools: 8 });
  const receipt = hydrateCapability(surface, { capability: "write-file", evidence: "I need to create a new file" });
  assert.equal(receipt.granted, false);
  assert.equal(receipt.reason, HYDRATION_DENY_REASON.POLICY_DENIED);
  assert.ok(!surface.advertised.includes("write"));
});

test("V16.5 tool surface: a side-effect capability needs an explicit policy check", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  const denied = hydrateCapability(surface, { capability: "write-file", evidence: "I need to create a new file" });
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, HYDRATION_DENY_REASON.SIDE_EFFECT_REQUIRES_POLICY);
  assert.equal(denied.policyChecked, true);
  assert.ok(!surface.advertised.includes("write"));

  const allowed = hydrateCapability(surface, { capability: "write-file", evidence: "I need to create a new file", allowSideEffectHydration: true });
  assert.equal(allowed.granted, true);
  assert.ok(surface.advertised.includes("write"));
});

test("V16.5 tool surface: hydration without evidence or for an unknown capability fails closed", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.equal(hydrateCapability(surface, { capability: "evidence-fetch" }).reason, HYDRATION_DENY_REASON.NO_EVIDENCE);
  assert.equal(hydrateCapability(surface, { capability: "invented-capability", evidence: "x" }).reason, HYDRATION_DENY_REASON.UNKNOWN_CAPABILITY);
  assert.equal(hydrateCapability(surface, { capability: "", evidence: "x" }).reason, HYDRATION_DENY_REASON.UNKNOWN_CAPABILITY);
  assert.equal(hydrateCapability(surface, { capability: "edit-file", evidence: "x" }).reason, HYDRATION_DENY_REASON.ALREADY_ADVERTISED);
});

test("V16.5 tool surface: hydration receipts are deterministic and hash-bound", () => {
  const first = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  const second = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  const a = hydrateCapability(first, { capability: "browser-automation", evidence: "visual check" });
  const b = hydrateCapability(second, { capability: "browser-automation", evidence: "visual check" });
  assert.equal(a.receiptId, b.receiptId);
  assert.equal(first.fingerprint, second.fingerprint);
});

test("V16.5 tool surface: phase prediction is deterministic", () => {
  for (const task of ["fix the bug", "verify the test suite", "investigate why it fails", "list the files"]) {
    assert.equal(predictCapabilities({ task }).phase, predictCapabilities({ task }).phase);
  }
  assert.equal(predictCapabilities({ task: "run the tests to verify" }).phase, "verify");
  assert.equal(predictCapabilities({ task: "find files that handle auth" }).phase, "orient");
  assert.equal(predictCapabilities({ task: "investigate the root cause" }).phase, "investigate");
});

test("V16.5 tool surface: unused advertised tools stay null until usage is observed", () => {
  const surface = compilePhaseToolSurface({ task: "fix the off-by-one in src/a.ts", universe: UNIVERSE, maxAdvertisedTools: 8 });
  assert.equal(surface.telemetry.unusedAdvertisedTools, null);
  const telemetry = finalizeToolSurfaceTelemetry(surface, { toolsUsed: ["read", "grep", "edit", "bash"] });
  assert.equal(telemetry.toolsUsed, 4);
  assert.deepEqual(telemetry.unusedAdvertisedToolNames, ["ues_code_edit"]);
  assert.equal(telemetry.unusedAdvertisedTools, 1);
});
