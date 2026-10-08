// V16.15 source integrity: V16.15 contracts hold, all prior releases intact.
//
// V16.15 adds a single-shot parallel coding runtime. A regression here means the
// release weakened an earlier guarantee: the V16.5 delegation fleet, the V16.12
// execution acceleration, the V16.13/V16.14 research path or the V16.8+ honesty
// contracts.

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
} from "../scripts/check-source-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("V16.15 source integrity passes", () => {
  assert.deepEqual(validateV16_15SourceIntegrity(), []);
});

test("V16.15 release consistency: no eval script names a test file that does not exist", () => {
  // The bounded runner DROPS a test file it cannot find, so a typo in an eval
  // script silently shrinks a release gate while the script still exits 0. This
  // was a real defect (eval:v14 named `context-engine-v14-context.test.mjs`,
  // which does not exist; the real file is `context-engine-v14.test.mjs`).
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
