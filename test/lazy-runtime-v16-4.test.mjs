import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hydrateRuntimeModule,
  isLazyModuleLoaded,
  lazyRuntimeTelemetry,
  registerLazyLoaderForTests,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs";

describe("lazy runtime hydration (V16.4 slice B)", () => {
  it("trivial boot loads no heavy modules", () => {
    resetLazyRuntimeForTests();
    assert.equal(isLazyModuleLoaded("deepseek-adapter"), false);
    assert.equal(isLazyModuleLoaded("browser-lane"), false);
    assert.equal(isLazyModuleLoaded("code-intelligence"), false);
    const t = lazyRuntimeTelemetry();
    assert.equal(t.lazyModulesLoaded, 0);
  });

  it("hydrates once and serves hits afterwards", async () => {
    resetLazyRuntimeForTests();
    let calls = 0;
    registerLazyLoaderForTests("unit-a", async () => { calls += 1; return { ok: true }; });
    const first = await hydrateRuntimeModule("unit-a");
    const second = await hydrateRuntimeModule("unit-a");
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls, 1);
    const t = lazyRuntimeTelemetry();
    assert.equal(t.lazyModulesLoaded, 1);
    assert.equal(t.lazyLoadHits, 1);
    assert.equal(t.lazyLoadMisses, 1);
  });

  it("simultaneous callers join the same promise", async () => {
    resetLazyRuntimeForTests();
    let calls = 0;
    registerLazyLoaderForTests("unit-join", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { joined: true };
    });
    const [a, b, c] = await Promise.all([
      hydrateRuntimeModule("unit-join"),
      hydrateRuntimeModule("unit-join"),
      hydrateRuntimeModule("unit-join"),
    ]);
    assert.equal(a.joined, true);
    assert.equal(b.joined, true);
    assert.equal(c.joined, true);
    assert.equal(calls, 1);
    assert.ok(lazyRuntimeTelemetry().lazyLoadJoinCount >= 2);
  });

  it("transient failure falls back without permanent poisoning", async () => {
    resetLazyRuntimeForTests();
    let calls = 0;
    registerLazyLoaderForTests("unit-flaky", async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { recovered: true };
    });
    const first = await hydrateRuntimeModule("unit-flaky", { fallback: { fallback: true } });
    assert.equal(first.fallback, true);
    assert.equal(isLazyModuleLoaded("unit-flaky"), false);
    const second = await hydrateRuntimeModule("unit-flaky");
    assert.equal(second.recovered, true);
    assert.equal(lazyRuntimeTelemetry().lazyLoadFailures, 1);
  });
});
