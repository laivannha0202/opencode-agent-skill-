import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareConsultationParallel } from "../lib/consult-prep.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("parallel read-only consult prep (V16.4 slice H)", () => {
  it("joins both lanes and reports latency", async () => {
    const result = await prepareConsultationParallel({
      laneA: async () => { await sleep(20); return { ready: true }; },
      laneB: async () => { await sleep(20); return { packetChars: 8000 }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.laneA.ready, true);
    assert.equal(result.laneB.packetChars, 8000);
    assert.ok(result.telemetry.joinMs < 100, `join took ${result.telemetry.joinMs}ms`);
    assert.ok(result.telemetry.laneAMs !== null && result.telemetry.laneBMs !== null);
  });

  it("AUTO falls back local when a lane fails; FORCE is unavailable", async () => {
    const auto = await prepareConsultationParallel({
      mode: "auto",
      laneA: async () => { throw new Error("no session"); },
      laneB: async () => ({ packetChars: 1 }),
    });
    assert.equal(auto.ok, false);
    assert.equal(auto.fallbackToLocal, true);
    const force = await prepareConsultationParallel({
      mode: "force",
      laneA: async () => { throw new Error("no session"); },
      laneB: async () => ({ packetChars: 1 }),
    });
    assert.equal(force.ok, false);
    assert.equal(force.code, "WEB_REASONING_UNAVAILABLE");
    assert.equal(force.fallbackToLocal, false);
  });

  it("lanes overlap instead of running serially", async () => {
    const started = Date.now();
    await prepareConsultationParallel({
      laneA: async () => { await sleep(50); return 1; },
      laneB: async () => { await sleep(50); return 2; },
    });
    assert.ok(Date.now() - started < 95, "lanes did not overlap");
  });
});
