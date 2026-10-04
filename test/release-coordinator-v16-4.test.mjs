import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  deriveEvalVerdicts,
  extractEvalFiles,
  unionFiles,
} from "../scripts/release-test-coordinator.mjs";

describe("release test coordinator (V16.4 slice I)", () => {
  it("extracts a union covering every coordinated eval exactly once", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const parsed = extractEvalFiles(pkg.scripts);
    assert.equal(parsed.ok, true, parsed.reason || "");
    assert.ok(parsed.mapping["eval:v16.4"]);
    const union = unionFiles(parsed.mapping);
    assert.equal(union.length, new Set(union).size);
    for (const [name, files] of Object.entries(parsed.mapping)) {
      for (const file of files) assert.ok(union.includes(file), `${name} file missing from union: ${file}`);
    }
    const total = Object.values(parsed.mapping).reduce((sum, files) => sum + files.length, 0);
    assert.ok(total >= union.length);
  });

  it("derives per-eval verdicts from per-file receipts", () => {
    const mapping = { "eval:a": ["test/x.test.mjs", "test/y.test.mjs"], "eval:b": ["test/y.test.mjs"] };
    const verdicts = deriveEvalVerdicts(mapping, new Set(["test/y.test.mjs"]));
    assert.equal(verdicts["eval:a"].pass, false);
    assert.equal(verdicts["eval:b"].pass, false);
    const clean = deriveEvalVerdicts(mapping, new Set());
    assert.equal(clean["eval:a"].pass, true);
  });

  it("fails closed when an eval is not a bounded-runner command", () => {
    const parsed = extractEvalFiles({ "eval:v15": "node something-else.mjs" });
    assert.equal(parsed.ok, false);
  });
});
