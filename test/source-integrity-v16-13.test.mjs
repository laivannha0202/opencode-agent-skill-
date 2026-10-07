// V16.13 source integrity: V16.13 contracts hold, all prior releases intact.

import test from "node:test";
import assert from "node:assert/strict";

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
  validateV16_10SourceIntegrity,
  validateV16_11SourceIntegrity,
  validateV16_12SourceIntegrity,
  validateV16_13SourceIntegrity,
} from "../scripts/check-source-integrity.mjs";

test("V16.13 source integrity passes", () => {
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
