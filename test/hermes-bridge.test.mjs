import test from "node:test"
import assert from "node:assert/strict"
import { buildHermesDelegationPrompt, buildHermesWorkflowPrompt, hermesOneShotArgs, hermesSidecarPlan } from "../lib/hermes-bridge.mjs"

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


test("V11 Hermes sidecar keeps UES as durable-state owner and accepts bounded workflow schedules", () => {
  const plan = hermesSidecarPlan({ maxConcurrent: 20 })
  assert.equal(plan.optional, true)
  assert.equal(plan.maxConcurrent, 16)
  assert.equal(plan.durableStateOwner, "ues")
  assert.equal(plan.safety.publish, false)
  const prompt = buildHermesWorkflowPrompt({ task: { id: "a" } }, { waves: [{ tasks: [{ id: "a" }] }] })
  assert.match(prompt, /bounded wave schedule/i)
  assert.match(prompt, /"id": "a"/)
})
