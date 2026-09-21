import test from "node:test"
import assert from "node:assert/strict"
import { evalModeOrder } from "../lib/eval-order.mjs"

test("paired live eval order is counterbalanced across trials", () => {
  assert.deepEqual(evalModeOrder("both", 0, 1), ["baseline", "ues"])
  assert.deepEqual(evalModeOrder("both", 0, 2), ["ues", "baseline"])
  assert.deepEqual(evalModeOrder("both", 0, 3), ["baseline", "ues"])
})

test("paired live eval order is counterbalanced across tasks", () => {
  assert.deepEqual(evalModeOrder("both", 0, 1), ["baseline", "ues"])
  assert.deepEqual(evalModeOrder("both", 1, 1), ["ues", "baseline"])
})

test("single-mode eval order remains unchanged", () => {
  assert.deepEqual(evalModeOrder("baseline", 5, 4), ["baseline"])
  assert.deepEqual(evalModeOrder("ues", 5, 4), ["ues"])
})
