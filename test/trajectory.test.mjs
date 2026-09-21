import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendTrajectoryEvent, readTrajectory, scrubTrajectoryValue } from "../lib/trajectory.mjs"

test("trajectory scrubs common credentials before persistence", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
  const value = scrubTrajectoryValue({
    authorization: "Bearer should-never-survive",
    apiKey: "plain-secret",
    nested: {
      text: "token=" + secret,
      npm: "npm_abcdefghijklmnopqrstuvwxyz123456",
    },
  })
  const encoded = JSON.stringify(value)
  assert.ok(!encoded.includes("should-never-survive"))
  assert.ok(!encoded.includes("plain-secret"))
  assert.ok(!encoded.includes(secret))
  assert.ok(!encoded.includes("npm_abcdefghijklmnopqrstuvwxyz123456"))
  assert.ok(encoded.includes("REDACTED"))
})

test("trajectory appends and reads bounded operational events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-trace-"))
  try {
    await appendTrajectoryEvent(root, "run-safe", "tool.call", { command: "npm test" })
    await appendTrajectoryEvent(root, "run-safe", "tool.result", { exitCode: 0 })
    const trace = await readTrajectory(root, "run-safe")
    assert.equal(trace.total, 2)
    assert.equal(trace.events[0].type, "tool.call")
    assert.match(trace.note, /hidden chain-of-thought is never recorded/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
