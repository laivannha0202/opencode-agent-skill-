import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  measureRepoMapQuery,
  summarizeRepoMapMeasurement,
} from "../lib/repo-map-measurements.mjs";

describe("repo-map measurements (V16.4 slice I)", () => {
  it("reports recall, rank and bytes without changing ranking", async () => {
    const ranked = [
      { path: "lib/a.mjs", chars: 1000 },
      { path: "lib/b.mjs", chars: 2000 },
      { path: "lib/c.mjs", chars: 500 },
    ];
    const { measurement } = await measureRepoMapQuery(async () => ranked, {}, ["lib/b.mjs", "lib/z.mjs"]);
    assert.equal(measurement.topKRecall, 0.5);
    assert.equal(measurement.firstCorrectFileRank, 2);
    assert.equal(measurement.bytesReadBeforeFirstCorrectEdit, 1000);
    assert.ok(measurement.queryLatencyMs !== null);
  });

  it("null recall when no known sites; flags repeated retrieval", () => {
    const m = summarizeRepoMapMeasurement({ ranked: [], knownEditSites: [] });
    assert.equal(m.topKRecall, null);
    assert.equal(m.firstCorrectFileRank, null);
    const names = [{ path: "x" }];
    const key = names.map((r) => r.path).join("\n");
    assert.equal(summarizeRepoMapMeasurement({ ranked: names, knownEditSites: ["x"], previousQuery: key }).repeatedRetrieval, true);
    assert.equal(summarizeRepoMapMeasurement({ ranked: names, knownEditSites: ["x"], previousQuery: "other" }).repeatedRetrieval, false);
  });
});
