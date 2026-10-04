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
});

const MODULE_LOADERS = {
  [LAZY_RUNTIME_MODULES.BROWSER_LANE]: () => import("./browser-lane.mjs"),
  [LAZY_RUNTIME_MODULES.BROWSER_WORKER_CLIENT]: () => import("./browser-worker-client.mjs"),
  [LAZY_RUNTIME_MODULES.DEEPSEEK_ADAPTER]: () => import("./deepseek-web-adapter.mjs"),
  [LAZY_RUNTIME_MODULES.WEB_REASONING_LANE]: () => import("./web-reasoning-lane.mjs"),
  [LAZY_RUNTIME_MODULES.CODE_INTELLIGENCE]: () => import("./code-intelligence/index.mjs"),
  [LAZY_RUNTIME_MODULES.CODE_PAYLOAD]: () => import("./code-intelligence/model-payload.mjs"),
  [LAZY_RUNTIME_MODULES.REPO_MAP]: () => import("./repo-map.mjs"),
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
