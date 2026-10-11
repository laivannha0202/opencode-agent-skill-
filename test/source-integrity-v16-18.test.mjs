// V16.18 source integrity: the adaptive full-power contracts hold, all prior
// releases intact.
//
// V16.18 makes the OVERHEAD adaptive while removing NO capability. A regression
// here means one of these silently came back:
//   * unknown scope paying STANDARD orchestration again;
//   * a second workspace-state authority, or a stale generation reused after a
//     mutation;
//   * the LSP stack becoming eagerly reachable on a docs/config task;
//   * LIGHT_CONTEXT becoming a CEILING instead of a first stage;
//   * a deferred capability becoming unreachable;
//   * a resource lease that can be raised past its global cap.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
  validateV16_10SourceIntegrity,
  validateV16_11SourceIntegrity,
  validateV16_12SourceIntegrity,
  validateV16_13SourceIntegrity,
  validateV16_14SourceIntegrity,
  validateV16_15SourceIntegrity,
  validateV16_16SourceIntegrity,
  validateV16_17SourceIntegrity,
  validateV16_18SourceIntegrity,
} from "../scripts/check-source-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("V16.18 source integrity passes", () => {
  assert.deepEqual(validateV16_18SourceIntegrity(), []);
});

test("V16.18 release consistency: no eval script names a test file that does not exist", () => {
  // The bounded runner DROPS a test file it cannot find, so a typo in an eval
  // script silently shrinks a release gate while the script still exits 0.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const missing = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (!name.startsWith("eval:") || typeof command !== "string") continue;
    for (const token of command.split(/\s+/)) {
      if (!token.startsWith("test/") || !token.endsWith(".mjs")) continue;
      if (!existsSync(path.join(ROOT, token))) missing.push(`${name} -> ${token}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("V16.18 the benchmark is a real gate, not a report", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts["bench:v16.18"], "the V16.18 benchmark must stay a real script");
  assert.ok(pkg.scripts["eval:v16.18"], "the V16.18 eval suite must stay a real script");
  assert.ok(pkg.scripts["release:verify"].includes("eval:v16.17"),
    "the release gate must still chain the previous eval suite");
  assert.ok(pkg.scripts["release:verify"].includes("eval:v16.18"),
    "the release gate must chain the current eval suite");
});

test("V16.17 source integrity still passes", () => {
  assert.deepEqual(validateV16_17SourceIntegrity(), []);
});

test("V16.16 source integrity still passes", () => {
  assert.deepEqual(validateV16_16SourceIntegrity(), []);
});

test("V16.15 source integrity still passes", () => {
  assert.deepEqual(validateV16_15SourceIntegrity(), []);
});

test("V16.14 source integrity still passes", () => {
  assert.deepEqual(validateV16_14SourceIntegrity(), []);
});

test("V16.13 source integrity still passes", () => {
  assert.deepEqual(validateV16_13SourceIntegrity(), []);
});

test("V16.12 source integrity still passes", () => {
  assert.deepEqual(validateV16_12SourceIntegrity(), []);
});

test("V16.11 source integrity still passes", () => {
  assert.deepEqual(validateV16_11SourceIntegrity(), []);
});

test("V16.10 source integrity still passes", () => {
  assert.deepEqual(validateV16_10SourceIntegrity(), []);
});

test("V16.9 source integrity still passes", () => {
  assert.deepEqual(validateV16_9SourceIntegrity(), []);
});

test("V16.8 source integrity still passes", () => {
  assert.deepEqual(validateV16_8SourceIntegrity(), []);
});
