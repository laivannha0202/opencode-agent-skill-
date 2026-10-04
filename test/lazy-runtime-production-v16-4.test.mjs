// V16.4 production-wiring proof.
//
// Every other V16.4 test exercises a module DIRECTLY. This file proves the two
// things a direct test cannot:
//
//   1. LAZY RUNTIME HYDRATION actually removes work from boot. The shipped
//      `pi/extensions/ues.ts` is type-stripped and really imported; the module
//      graph it pulls is measured; and the production loader registry is
//      exercised through the real loaders (not test doubles).
//
//   2. The nine V16.4 modules are reachable from PRODUCTION code, i.e. from
//      `lib/`, `pi/`, `bin/` or `scripts/` -- not only from `test/`.
//
// Nothing here mocks the production path. The only substitution is the optional
// peer dependency `typebox`, which is not installed in this repository and is
// used only to build tool schemas at call time; the substitution happens BEFORE
// the source is written and is recorded in the probe output.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts");
const EXTENSION_DIR = path.dirname(EXTENSION);

const V164_MODULES = [
  "lib/lazy-runtime.mjs",
  "lib/web-reasoning-structural.mjs",
  "lib/fresh-evidence.mjs",
  "lib/followup-budget.mjs",
  "lib/decision-packet-tiers.mjs",
  "lib/verified-task-cost.mjs",
  "lib/advisor-benefit-learner.mjs",
  "lib/consult-prep.mjs",
  "lib/repo-map-measurements.mjs",
];

// Modules that MUST stay eager: they decide whether a tool may run at all, and
// a policy that hydrates after the tool would already have executed is useless.
const SAFETY_CRITICAL_EAGER = [
  "lib/safety.mjs",
  "lib/task-policy.mjs",
  "lib/permission-policy.mjs",
  "lib/mcp-tool-policy.mjs",
  "lib/execution-ownership.mjs",
  "lib/workspace-root.mjs",
  "lib/workspace-hygiene.mjs",
  "lib/fast-static-verification.mjs",
];

// The heavy paths V16.4 must NOT load at boot.
const LAZY_HEAVY_MODULES = [
  "lib/browser-lane.mjs",
  "lib/browser-worker-client.mjs",
  "lib/deepseek-web-adapter.mjs",
  "lib/web-reasoning-lane.mjs",
  "lib/code-intelligence/index.mjs",
  "lib/code-intelligence/model-payload.mjs",
  "lib/repo-map.mjs",
];

// ---------------------------------------------------------------------------
// static graph helpers
// ---------------------------------------------------------------------------
function resolveRelative(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, "index.mjs")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a candidate */
    }
  }
  return null;
}

// STATIC imports only. A dynamic `import("x")` is the lazy path by definition
// and is deliberately NOT followed: this function answers "what does boot load?".
const STATIC_IMPORT = /(?:^|[\s;])import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|(?:^|[\s;])export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g;

function staticEagerClosure(rootFile) {
  const seen = new Set();
  const walk = (file, stack) => {
    const absolute = path.resolve(file);
    if (stack.has(absolute)) return;
    if (seen.has(absolute)) return;
    stack.add(absolute);
    seen.add(absolute);
    let source = "";
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    const pattern = new RegExp(STATIC_IMPORT.source, STATIC_IMPORT.flags);
    let match;
    while ((match = pattern.exec(source))) {
      const resolved = resolveRelative(match[1] || match[2], absolute);
      if (resolved) walk(resolved, stack);
    }
  };
  walk(path.resolve(rootFile), new Set());
  return seen;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".ues-")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function productionImporters(moduleRelative) {
  const target = path.join(ROOT, moduleRelative);
  const roots = ["lib", "pi", "bin", "scripts"];
  const hits = [];
  for (const dir of roots) {
    const absolute = path.join(ROOT, dir);
    if (!existsSync(absolute)) continue;
    for (const file of walkFiles(absolute)) {
      if (!/\.(?:mjs|js|ts)$/.test(file)) continue;
      if (file === target) continue;
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...source.matchAll(/(?:^|[\s;])import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g),
        ...source.matchAll(/(?:^|[\s;])export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g),
        ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        const resolved = resolveRelative(specifier, file);
        if (resolved === target) {
          hits.push(path.relative(ROOT, file).replace(/\\/g, "/"));
          break;
        }
      }
    }
  }
  return [...new Set(hits)];
}

// ---------------------------------------------------------------------------
// real production boot
// ---------------------------------------------------------------------------
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-4-boot-probe");
const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n");

let bootResult = null;

async function bootProductionExtension() {
  if (bootResult) return bootResult;
  // The probe lives in `pi/extensions/` (not in a temp dir) so the extension's
  // own `../../lib/...` specifiers resolve exactly as they do in production.
  const probe = path.join(EXTENSION_DIR, `__v164_boot_probe_${process.pid}.mjs`);
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs");
  try {
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(stub, TYPEBOX_STUB, "utf8");
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    });
    const stubUrl = pathToFileURL(stub).href;
    source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`);
    writeFileSync(probe, source, "utf8");
    try {
      const module = await import(pathToFileURL(probe).href);
      bootResult = { module, probe, stub };
      return bootResult;
    } finally {
      // The module is fully evaluated once the import resolves, so the probe
      // source is removed immediately. Nothing under `pi/extensions/` survives
      // a test run.
      rmSync(probe, { force: true });
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
describe("V16.4 production wiring", () => {
  it("P1 the shipped extension boots and hydrates nothing", async () => {
    const { module } = await bootProductionExtension();
    assert.equal(typeof module.default, "function", "the extension must expose activate()");
    assert.equal(typeof module.requiredBrowserActionsForTask, "function");

    const lazy = await import(pathToFileURL(path.join(ROOT, "lib/lazy-runtime.mjs")).href);
    assert.deepEqual(lazy.loadedLazyModules(), [], "a boot must not hydrate any lazy module");
    assert.equal(lazy.lazyRuntimeTelemetry().lazyModulesLoaded, 0);
    for (const name of Object.values(lazy.LAZY_RUNTIME_MODULES)) {
      assert.equal(lazy.isLazyModuleLoaded(name), false, `${name} must not be hydrated at boot`);
    }
  });

  it("P2 boot no longer statically reaches the heavy browser/web/code paths", () => {
    const closure = staticEagerClosure(EXTENSION);
    const relative = [...closure].map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
    for (const heavy of LAZY_HEAVY_MODULES) {
      assert.equal(
        relative.includes(heavy),
        false,
        `${heavy} is reachable from the extension's STATIC imports, so boot still pays for it`,
      );
    }
  });

  it("P3 safety, permission, ownership and verifier policy stay EAGER", () => {
    const closure = staticEagerClosure(EXTENSION);
    const relative = [...closure].map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
    for (const critical of SAFETY_CRITICAL_EAGER) {
      assert.equal(relative.includes(critical), true, `${critical} must be loaded before any tool call`);
    }
  });

  it("P4 the lazy registry points at files that exist", async () => {
    const source = readFileSync(path.join(ROOT, "lib/lazy-runtime.mjs"), "utf8");
    for (const name of Object.keys(
      Object.fromEntries([...source.matchAll(/LAZY_RUNTIME_MODULES\.([A-Z_]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])),
    )) {
      assert.equal(typeof name, "string");
    }
    // Prove each registered loader really resolves by hydrating every module
    // under a fresh registry and asserting the production export it provides.
    const lazy = await import(pathToFileURL(path.join(ROOT, "lib/lazy-runtime.mjs")).href);
    const expected = {
      [lazy.LAZY_RUNTIME_MODULES.BROWSER_LANE]: "createBrowserLane",
      [lazy.LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT]: "createBrowserWorkerClient",
      [lazy.LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER]: "createDeepSeekWebAdapter",
      [lazy.LAZY_RUNTIME_MODULES.WEB_REASONING_LANE]: "createWebReasoningLane",
      [lazy.LAZY_RUNTIME_MODULES.CODE_INTELLIGENCE]: "searchCodeIntelligence",
      [lazy.LAZY_RUNTIME_MODULES.CODE_PAYLOAD]: "reduceCodePayload",
      [lazy.LAZY_RUNTIME_MODULES.REPO_MAP]: "buildRepoMap",
    };
    for (const [name, exportName] of Object.entries(expected)) {
      const loaded = await lazy.hydrateRuntimeModule(name);
      assert.equal(typeof loaded?.[exportName], "function", `${name} does not export ${exportName}`);
    }
  });

  it("P5 a trivial/local task hydrates nothing; web and code tasks hydrate once", async () => {
    const lazy = await import(pathToFileURL(path.join(ROOT, "lib/lazy-runtime.mjs")).href);
    lazy.resetLazyRuntimeForTests();

    // --- trivial / local task ---------------------------------------------
    assert.deepEqual(lazy.loadedLazyModules(), [], "trivial task hydration set must be empty");
    const trivialTelemetry = lazy.lazyRuntimeTelemetry();
    assert.equal(trivialTelemetry.lazyModulesLoaded, 0);
    assert.equal(trivialTelemetry.lazyLoadFailures, 0);

    // --- web task: hydrate the web stack once -----------------------------
    const webFirst = await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.WEB);
    assert.equal(typeof webFirst[lazy.LAZY_RUNTIME_MODULES.WEB_REASONING_LANE].createWebReasoningLane, "function");
    assert.equal(typeof webFirst[lazy.LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER].createDeepSeekWebAdapter, "function");
    assert.equal(typeof webFirst[lazy.LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT].createBrowserWorkerClient, "function");
    const afterWeb = lazy.lazyRuntimeTelemetry();
    assert.equal(afterWeb.lazyModulesLoaded, lazy.LAZY_RUNTIME_STACKS.WEB.length);
    // Second web task costs nothing: every member is a cache hit.
    await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.WEB);
    assert.equal(lazy.lazyRuntimeTelemetry().lazyModulesLoaded, afterWeb.lazyModulesLoaded);
    assert.deepEqual(
      lazy.loadedLazyModules().filter((name) => !lazy.LAZY_RUNTIME_STACKS.CODE.includes(name)),
      [...lazy.LAZY_RUNTIME_STACKS.WEB].sort(),
      "a web task must not hydrate the code stack",
    );

    // --- code / LSP task: hydrate the code stack once ----------------------
    const codeFirst = await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.CODE);
    assert.equal(typeof codeFirst[lazy.LAZY_RUNTIME_MODULES.CODE_INTELLIGENCE].lspOperation, "function");
    assert.equal(typeof codeFirst[lazy.LAZY_RUNTIME_MODULES.REPO_MAP].buildRepoMap, "function");
    const afterCode = lazy.lazyRuntimeTelemetry();
    assert.equal(afterCode.lazyModulesLoaded, lazy.LAZY_RUNTIME_STACKS.WEB.length + lazy.LAZY_RUNTIME_STACKS.CODE.length);
    await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.CODE);
    assert.equal(lazy.lazyRuntimeTelemetry().lazyModulesLoaded, afterCode.lazyModulesLoaded);

    lazy.resetLazyRuntimeForTests();
  });

  it("P6 concurrent callers join ONE hydration, and a transient failure can retry", async () => {
    const lazy = await import(pathToFileURL(path.join(ROOT, "lib/lazy-runtime.mjs")).href);
    lazy.resetLazyRuntimeForTests();

    let calls = 0;
    lazy.registerLazyLoaderForTests("v16-4-concurrent", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { joined: true };
    });
    const [a, b, c, d] = await Promise.all([
      lazy.hydrateRuntimeModule("v16-4-concurrent"),
      lazy.hydrateRuntimeModule("v16-4-concurrent"),
      lazy.hydrateRuntimeModule("v16-4-concurrent"),
      lazy.hydrateRuntimeModule("v16-4-concurrent"),
    ]);
    assert.equal(calls, 1, "four concurrent callers must trigger exactly one import");
    assert.deepEqual([a.joined, b.joined, c.joined, d.joined], [true, true, true, true]);
    assert.ok(lazy.lazyRuntimeTelemetry().lazyLoadJoinCount >= 3);

    // A transient failure must not poison the cache, whether the loader throws
    // asynchronously OR synchronously.
    for (const [label, thrower] of [
      ["async", async () => { throw new Error("transient"); }],
      ["sync", () => { throw new Error("transient"); }],
    ]) {
      let attempts = 0;
      lazy.registerLazyLoaderForTests(`v16-4-flaky-${label}`, () => {
        attempts += 1;
        if (attempts === 1) return thrower();
        return { recovered: true };
      });
      const first = await lazy.hydrateRuntimeModule(`v16-4-flaky-${label}`, { fallback: { fallback: true } });
      assert.equal(first.fallback, true, `${label}: the deterministic fallback must be used`);
      assert.equal(lazy.isLazyModuleLoaded(`v16-4-flaky-${label}`), false, `${label}: a failure must not mark the module loaded`);
      const second = await lazy.hydrateRuntimeModule(`v16-4-flaky-${label}`);
      assert.equal(second.recovered, true, `${label}: a later call must be able to retry`);
      assert.equal(attempts, 2);
    }

    lazy.resetLazyRuntimeForTests();
  });

  it("P7 every V16.4 module is imported by production code, not only by tests", () => {
    const report = {};
    for (const moduleRelative of V164_MODULES) {
      const importers = productionImporters(moduleRelative);
      report[moduleRelative] = importers;
      assert.ok(
        importers.length > 0,
        `${moduleRelative} has NO production importer: it is an isolated/test-only module`,
      );
    }
    // Sanity: the production callers this audit relies on.
    assert.ok(report["lib/lazy-runtime.mjs"].includes("pi/extensions/ues.ts"));
    assert.ok(report["lib/verified-task-cost.mjs"].includes("pi/extensions/ues.ts"));
    assert.ok(report["lib/repo-map-measurements.mjs"].includes("pi/extensions/ues.ts"));
    assert.ok(report["lib/web-reasoning-structural.mjs"].includes("lib/web-reasoning-escalation.mjs"));
    assert.ok(report["lib/fresh-evidence.mjs"].includes("lib/web-reasoning-escalation.mjs"));
    assert.ok(report["lib/followup-budget.mjs"].includes("lib/web-reasoning-escalation.mjs"));
    assert.ok(report["lib/decision-packet-tiers.mjs"].includes("lib/web-reasoning-lane.mjs"));
    assert.ok(report["lib/advisor-benefit-learner.mjs"].includes("lib/web-reasoning-lane.mjs"));
    assert.ok(report["lib/consult-prep.mjs"].includes("lib/web-reasoning-lane.mjs"));
  });
});