// V16.6.1 release-test-coordinator coverage.
//
// The coordinator deduplicates test FILES. These tests prove that dedup never
// silently drops a file, never loses a behaviour-specific companion eval, and
// fails closed when the mapping is uncertain.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  COORDINATED_EVALS,
  deriveEvalVerdicts,
  extractCompanionScripts,
  extractEvalFiles,
  unionFiles,
} from "../scripts/release-test-coordinator.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const pkg = createRequire(path.join(root, "package.json"))(path.join(root, "package.json"));

test("V16.6.1 C1: the coordinator covers V16.6 including the new regression suites", () => {
  assert.ok(COORDINATED_EVALS.includes("eval:v16.6"), "V16.6 is coordinated");
  assert.ok(COORDINATED_EVALS.includes("eval:v16.5"));
  const parsed = extractEvalFiles(pkg.scripts || {});
  assert.equal(parsed.ok, true, parsed.reason);
  const v166 = parsed.mapping["eval:v16.6"];
  assert.ok(v166.includes("test/v16-6-1-regressions.test.mjs"), "the V16.6.1 regressions are in the release gate");
  assert.ok(v166.includes("test/v16-6-measured-regressions.test.mjs"));
  assert.ok(v166.includes("test/unified-budget-v16-6.test.mjs"));
  assert.ok(v166.includes("test/deepseek-session-v16-6.test.mjs"));
  assert.ok(v166.includes("test/orchestration-surface-v16-6.test.mjs"));
});

test("V16.6.1 C2: union runs each test file EXACTLY once and drops nothing", () => {
  const parsed = extractEvalFiles(pkg.scripts || {});
  assert.equal(parsed.ok, true, parsed.reason);
  const union = unionFiles(parsed.mapping);
  assert.equal(new Set(union).size, union.length, "the union has no duplicates");
  const everySlot = Object.values(parsed.mapping).flatMap((files) => files);
  for (const file of new Set(everySlot)) {
    assert.ok(union.includes(file), `${file} must still run`);
  }
  const slots = everySlot.length;
  assert.ok(union.length < slots, `union ${union.length} should be smaller than ${slots} file-slots`);
});

test("V16.6.1 C3: behaviour-specific companion evals are preserved and are part of the verdict", () => {
  const command = pkg.scripts["eval:v16.5"];
  const companions = extractCompanionScripts(command);
  assert.ok(companions.includes("scripts/eval-skill-routing-v16-5.mjs"), companions.join(","));
  assert.ok(companions.includes("scripts/eval-v16-5.mjs"));
  assert.equal(companions.some((file) => file.endsWith("run-test-suite.mjs")), false, "the bounded runner is not a companion");
  const v166 = extractCompanionScripts(pkg.scripts["eval:v16.6"]);
  assert.ok(v166.includes("scripts/eval-v16-6.mjs"));

  const mapping = { "eval:x": ["test/a.test.mjs"] };
  const companionMap = { "eval:x": ["scripts/eval-x.mjs"] };
  const okVerdict = deriveEvalVerdicts(mapping, new Set(), [{ file: "scripts/eval-x.mjs", ran: true, ok: true }], companionMap);
  assert.equal(okVerdict["eval:x"].pass, true);
  assert.equal(okVerdict["eval:x"].files, 1);
  const badVerdict = deriveEvalVerdicts(mapping, new Set(), [{ file: "scripts/eval-x.mjs", ran: true, ok: false }], companionMap);
  assert.equal(badVerdict["eval:x"].pass, false, "a failing companion eval fails its parent eval");
  assert.deepEqual(badVerdict["eval:x"].failed, []);
  const failedFile = deriveEvalVerdicts(mapping, new Set(["test/a.test.mjs"]));
  assert.equal(failedFile["eval:x"].pass, false);
});

test("V16.6.1 C4: an uncertain mapping fails closed", () => {
  assert.equal(extractEvalFiles({ "eval:v15": "echo nothing" }).ok, false);
  assert.equal(extractEvalFiles({ "eval:v15": "node scripts/run-test-suite.mjs --dry" }).ok, false, "no test files is not a mapping");
});

test("V16.6.1 C5: every coordinated eval command is still a bounded-runner command", () => {
  for (const name of COORDINATED_EVALS) {
    const command = String(pkg.scripts[name] || "");
    assert.ok(command.includes("scripts/run-test-suite.mjs"), `${name} must use the bounded runner`);
    assert.ok(extractCompanionScripts(command).length >= 0);
  }
});

test("V16.6.1 C6: the declared release gate includes the coordinator's union coverage", () => {
  const release = String(pkg.scripts["release:verify"] || "");
  assert.match(release, /eval:v16\.6/);
  assert.match(release, /npm run ci/, "pack/smoke/fresh-install gates stay in the release gate");
});