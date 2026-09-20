import test from "node:test"
import assert from "node:assert/strict"
import { buildHermesDelegationPrompt, hermesOneShotArgs } from "../lib/hermes-bridge.mjs"

test("Hermes bridge emits bounded one-shot CLI arguments", () => {
  const prompt = buildHermesDelegationPrompt({
    slug: "demo",
    task: { id: "T1", title: "Implement" },
  })
  const args = hermesOneShotArgs(prompt)
  assert.deepEqual(args.slice(0, 2), ["chat", "-q"])
  assert.match(args[2], /optional external executor/)
  assert.match(args[2], /"id": "T1"/)
})

test("Hermes one-shot builder rejects an empty prompt", () => {
  assert.throws(() => hermesOneShotArgs(""), /prompt is required/)
})
