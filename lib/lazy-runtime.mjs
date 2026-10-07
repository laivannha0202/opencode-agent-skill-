// V16.4 Slice B: lazy runtime hydration -- PRODUCTION WIRING.
//
// Trivial tasks must not pay for the browser / DeepSeek / repo-map /
// code-intelligence modules at boot. The Pi extension (`pi/extensions/ues.ts`)
// resolves every entry below through `hydrateRuntimeModule`, so these modules
// are reachable ONLY through a first real use, never through a static import.
//
// What deliberately stays EAGER, because it must exist BEFORE any tool call and
// therefore can never be "hydrated later" safely:
//   safety, task-policy, permission-policy, mcp-tool-policy,
//   execution-ownership, workspace-root/workspace-hygiene,
//   fast-static-verification (verifier policy) and therefore the LSP
//   provider/pool it statically imports.
//
// Guarantees:
//   - one hydration per module per process (concurrent callers join);
//   - transient import failure does NOT poison the cache;
//   - deterministic fallback value on failure;
//   - bounded telemetry (hits/misses/joins/latency/failures).

const entries = new Map();

export const LAZY_RUNTIME_MODULES = Object.freeze({
  BROWSER_LANE: "browser-lane",
  BROWSER_WORKER_CLIENT: "browser-worker-client",
  DEEPSEEK_ADAPTER: "deepseek-adapter",
  WEB_REASONING_LANE: "web-reasoning-lane",
  CODE_INTELLIGENCE: "code-intelligence",
  CODE_PAYLOAD: "code-payload",
  REPO_MAP: "repo-map",
  // V16.6.1: the V16.6 session stack (consult cache / resume capsule /
  // evidence requests) was hydrated through `lib/v16-6-runtime.mjs` only, while
  // `pi/extensions/ues.ts` still STATIC-imported `lib/deepseek-consult-cache.mjs`.
  // A module advertised as lazy but statically imported by the main extension is
  // not lazy: every cold start paid for it. These entries make the real graph
  // match the declared one, and the extension loads them through
  // `loadSessionRuntime()` only when a run actually consults.
  DEEPSEEK_SESSION_BUDGET: "deepseek-session-budget",
  DEEPSEEK_SESSION_POOL: "deepseek-session-pool",
  DEEPSEEK_CONSULT_CACHE: "deepseek-consult-cache",
  DEEPSEEK_RESUME_CAPSULE: "deepseek-resume-capsule",
  DEEPSEEK_EVIDENCE_REQUESTS: "deepseek-evidence-requests",
  // V16.9: the evidence BROKER is the single owner of the "advisor ASKS for
  // local evidence" loop. It wraps `deepseek-evidence-requests.mjs` (the ONE
  // authority path for parsing/authorizing/redacting) with a source registry
  // and one bounded `serve()`. It is hydrated with the session stack, so a run
  // that never consults never pays for it.
  EVIDENCE_BROKER: "evidence-broker",
  // V16.9: the SHARED CONTEXT LEDGER is the broker's internal dedup primitive
  // (it wraps `seen-context-ledger.mjs`). It is hydrated with the session stack
  // and INJECTED into the broker, so a non-consulting run never loads it.
  SHARED_CONTEXT_LEDGER: "shared-context-ledger",
  // V16.11: the advisor LIFECYCLE identity (epochs + stale-event gate). Pure and
  // tiny, hydrated with the session stack. It is the single owner of the
  // worker/conversation/run epochs the session manager reads.
  ADVISOR_LIFECYCLE: "advisor-lifecycle-v16-11",
  // V16.11: the SESSION MANAGER is the single production owner of the three
  // advisor lifecycles (worker lease, conversation, run). It was built in V16.9
  // but deliberately not wired; V16.11 wires it through `ADVISOR_RUNTIME`.
  ADVISOR_SESSION_MANAGER: "advisor-session-manager",
  // V16.11: the Browser Transport V2 protocol (event channel + polling fallback).
  BROWSER_TRANSPORT_V2: "browser-transport-v16-11",
  // V16.11: the event-first answer bridge (events first, bounded poll fallback).
  ADVISOR_EVENT_BRIDGE: "advisor-event-bridge-v16-11",
  // V16.11: bounded recovery + duplicate-submit prevention.
  ADVISOR_RECOVERY: "advisor-recovery-v16-11",
  // V16.11: honest cold/warm + event/poll latency aggregation.
  ADVISOR_LATENCY_METRICS: "advisor-latency-metrics-v16-11",
  // V16.11: proven Windows resource cleanup receipt.
  WINDOWS_RESOURCE_HYGIENE: "windows-resource-hygiene-v16-11",
  // V16.11: the production composition that owns ONE advisor session manager per
  // run and threads the event bridge, recovery and latency metrics into it.
  ADVISOR_RUNTIME: "advisor-runtime-v16-11",
  // V16.7: the profile registry is read (metadata only, never a credential) to
  // scope the consult cache by OPAQUE profile id so two DeepSeek accounts can
  // never share a cached answer.
  DEEPSEEK_PROFILE_REGISTRY: "deepseek-profile-registry",
  // Parallel reasoning is only reachable on a DEEP run that consults.
  PARALLEL_REASONING: "parallel-reasoning-v16-6",
});

// Production stacks. A "stack" is the set of modules one real capability needs;
// hydrating a stack hydrates each member through the same cached, joined
// hydration, so the second caller of the same stack costs nothing.
export const LAZY_RUNTIME_STACKS = Object.freeze({
  BROWSER: Object.freeze([LAZY_RUNTIME_MODULES.BROWSER_LANE, LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT]),
  WEB: Object.freeze([
    LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER,
    LAZY_RUNTIME_MODULES.WEB_REASONING_LANE,
    LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT,
  ]),
  CODE: Object.freeze([
    LAZY_RUNTIME_MODULES.CODE_INTELLIGENCE,
    LAZY_RUNTIME_MODULES.CODE_PAYLOAD,
    LAZY_RUNTIME_MODULES.REPO_MAP,
  ]),
  // V16.6.1: the whole V16.6 session stack, hydrated together. A run that never
  // consults DeepSeek never touches any of it. The session pool stays out of
  // the production stack: one run owns one conversation, so pool arbitration
  // would be a second owner for the same session. The module remains
  // importable for tests/future multi-session use.
  DEEPSEEK_SESSION: Object.freeze([
    LAZY_RUNTIME_MODULES.DEEPSEEK_SESSION_BUDGET,
    LAZY_RUNTIME_MODULES.DEEPSEEK_CONSULT_CACHE,
    LAZY_RUNTIME_MODULES.DEEPSEEK_RESUME_CAPSULE,
    LAZY_RUNTIME_MODULES.DEEPSEEK_EVIDENCE_REQUESTS,
    LAZY_RUNTIME_MODULES.EVIDENCE_BROKER,
    LAZY_RUNTIME_MODULES.SHARED_CONTEXT_LEDGER,
    LAZY_RUNTIME_MODULES.PARALLEL_REASONING,
  ]),
  // V16.11: the advisor lifecycle stack. Hydrated only when a run actually
  // consults DeepSeek, so a non-consulting run never loads any of it.
  ADVISOR_LIFECYCLE: Object.freeze([
    LAZY_RUNTIME_MODULES.ADVISOR_LIFECYCLE,
    LAZY_RUNTIME_MODULES.ADVISOR_SESSION_MANAGER,
    LAZY_RUNTIME_MODULES.ADVISOR_EVENT_BRIDGE,
    LAZY_RUNTIME_MODULES.ADVISOR_RECOVERY,
    LAZY_RUNTIME_MODULES.ADVISOR_LATENCY_METRICS,
    LAZY_RUNTIME_MODULES.ADVISOR_RUNTIME,
  ]),
});

const MODULE_LOADERS = {
  [LAZY_RUNTIME_MODULES.BROWSER_LANE]: () => import("./browser-lane.mjs"),
  [LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT]: () => import("./browser-worker-client.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER]: () => import("./deepseek-web-adapter.mjs"),
  // V16.9 keeps the proven V16.7 lane as the policy/verification owner and the
  // V16.8 wrapper as the barrier/overlap owner, and hydrates a thin lifecycle
  // wrapper that adds adaptive admission, single-flight dialogue sequencing, a
  // shared workspace-state owner and a WRITE-side pre-write fence. The module
  // re-exports the V16.8 lane verbatim, so every existing caller keeps the same
  // result shape.
  [LAZY_RUNTIME_MODULES.WEB_REASONING_LANE]: () => import("./web-reasoning-lane-v16-9.mjs"),
  [LAZY_RUNTIME_MODULES.CODE_INTELLIGENCE]: () => import("./code-intelligence/index.mjs"),
  [LAZY_RUNTIME_MODULES.CODE_PAYLOAD]: () => import("./code-intelligence/model-payload.mjs"),
  [LAZY_RUNTIME_MODULES.REPO_MAP]: () => import("./repo-map.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_SESSION_BUDGET]: () => import("./deepseek-session-budget.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_SESSION_POOL]: () => import("./deepseek-session-pool.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_CONSULT_CACHE]: () => import("./deepseek-consult-cache.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_RESUME_CAPSULE]: () => import("./deepseek-resume-capsule.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_EVIDENCE_REQUESTS]: () => import("./deepseek-evidence-requests.mjs"),
  [LAZY_RUNTIME_MODULES.EVIDENCE_BROKER]: () => import("./evidence-broker.mjs"),
  [LAZY_RUNTIME_MODULES.SHARED_CONTEXT_LEDGER]: () => import("./shared-context-ledger.mjs"),
  [LAZY_RUNTIME_MODULES.PARALLEL_REASONING]: () => import("./parallel-reasoning-v16-6.mjs"),
  // V16.11 advisor lifecycle stack.
  [LAZY_RUNTIME_MODULES.ADVISOR_LIFECYCLE]: () => import("./advisor-lifecycle-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.ADVISOR_SESSION_MANAGER]: () => import("./advisor-session-manager.mjs"),
  [LAZY_RUNTIME_MODULES.BROWSER_TRANSPORT_V2]: () => import("./browser-transport-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.ADVISOR_EVENT_BRIDGE]: () => import("./advisor-event-bridge-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.ADVISOR_RECOVERY]: () => import("./advisor-recovery-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.ADVISOR_LATENCY_METRICS]: () => import("./advisor-latency-metrics-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.WINDOWS_RESOURCE_HYGIENE]: () => import("./windows-resource-hygiene-v16-11.mjs"),
  [LAZY_RUNTIME_MODULES.ADVISOR_RUNTIME]: () => import("./advisor-runtime-v16-11.mjs"),
};

const telemetry = {
  lazyModulesLoaded: 0,
  lazyLoadHits: 0,
  lazyLoadMisses: 0,
  lazyLoadJoinCount: 0,
  lazyLoadLatencyMs: 0,
  lazyLoadFailures: 0,
};

function entryFor(name) {
  let entry = entries.get(name);
  if (!entry) {
    entry = { promise: null, module: null, waiters: 0 };
    entries.set(name, entry);
  }
  return entry;
}

export function isLazyModuleLoaded(name) {
  return entries.get(name)?.module != null;
}

export function loadedLazyModules() {
  return [...entries.keys()].filter((name) => entries.get(name)?.module != null).sort();
}

export function lazyRuntimeTelemetry() {
  return { ...telemetry };
}

export function resetLazyRuntimeForTests() {
  entries.clear();
  telemetry.lazyModulesLoaded = 0;
  telemetry.lazyLoadHits = 0;
  telemetry.lazyLoadMisses = 0;
  telemetry.lazyLoadJoinCount = 0;
  telemetry.lazyLoadLatencyMs = 0;
  telemetry.lazyLoadFailures = 0;
}

export function registerLazyLoaderForTests(name, loader) {
  MODULE_LOADERS[name] = loader;
}

/**
 * Hydrate a runtime module on demand.
 * `options.fallback` is the deterministic value used when the import fails.
 * `options.loader` overrides the registry (tests / epoch-scoped wiring).
 */
export async function hydrateRuntimeModule(name, options = {}) {
  const entry = entryFor(name);
  if (entry.module) {
    telemetry.lazyLoadHits += 1;
    return entry.module;
  }
  if (entry.promise) {
    telemetry.lazyLoadJoinCount += 1;
    return entry.promise;
  }
  const loader = options.loader || MODULE_LOADERS[name];
  if (typeof loader !== "function") throw new Error(`Unknown lazy runtime module: ${name}`);
  telemetry.lazyLoadMisses += 1;
  const started = Date.now();
  entry.waiters += 1;
  // The loader is invoked from a microtask boundary. Without that yield, a
  // loader that throws SYNCHRONOUSLY would run this function's catch/finally
  // (which clears `entry.promise`) BEFORE the assignment below cached the
  // promise, and the cleared slot would then be overwritten by the already
  // settled promise -- permanently poisoning the module against retry.
  const run = async () => {
    await Promise.resolve();
    try {
      const loaded = await loader();
      entry.module = loaded;
      telemetry.lazyModulesLoaded += 1;
      telemetry.lazyLoadLatencyMs += Date.now() - started;
      return loaded;
    } catch (error) {
      // Transient failure: drop the promise so a later call can retry.
      telemetry.lazyLoadFailures += 1;
      entry.promise = null;
      if ("fallback" in options) return options.fallback;
      throw error;
    } finally {
      entry.waiters = 0;
    }
  };
  entry.promise = run();
  return entry.promise;
}

/**
 * Hydrate every module of a production stack concurrently and return them keyed
 * by module name. Concurrent callers join the same per-module promises, so the
 * second caller never triggers a second import.
 */
export async function hydrateRuntimeStack(names, options = {}) {
  const list = [...names];
  const loaded = await Promise.all(list.map((name) => hydrateRuntimeModule(name, options)));
  const out = {};
  for (let i = 0; i < list.length; i += 1) out[list[i]] = loaded[i];
  return out;
}
