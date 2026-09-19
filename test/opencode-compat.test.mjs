import test from "node:test"
import assert from "node:assert/strict"
import { adaptAgentForOpenCode, buildOpenCodeRunArgs, capabilitiesFromHelp, parseOpenCodeMajor } from "../lib/opencode-compat.mjs"

test("OpenCode version parsing accepts normal CLI versions", () => {
  assert.equal(parseOpenCodeMajor("1.18.31"), 1)
  assert.equal(parseOpenCodeMajor("OpenCode 2.4.0"), 2)
  assert.equal(parseOpenCodeMajor("garbage"), null)
})

test("v2 agent adaptation converts legacy edit/write permission block", () => {
  const source = `---
description: reviewer
mode: subagent
permission:
  edit: deny
  write: deny
---

Review.
`
  const v1 = adaptAgentForOpenCode(source, 1)
  assert.match(v1, /permission:/)
  const v2 = adaptAgentForOpenCode(source, 2)
  assert.doesNotMatch(v2, /permission:/)
  assert.match(v2, /permissions:/)
  assert.match(v2, /action: edit/)
  assert.match(v2, /effect: deny/)
})


test("live eval invocation omits standalone on OpenCode 1.x", () => {
  const args = buildOpenCodeRunArgs({
    major: 1,
    model: "opencode/big-pickle",
    workspace: "C:\\repo",
    prompt: "Reply exactly: OK",
  })

  assert.equal(args[0], "run")
  assert.equal(args.includes("--standalone"), false)
  assert.deepEqual(args.slice(1, 5), ["--format", "json", "--auto", "--agent"])
  assert.ok(args.includes("opencode/big-pickle"))
  assert.equal(args.at(-1), "Reply exactly: OK")
})

test("live eval invocation keeps standalone for OpenCode 2.x and newer", () => {
  const args = buildOpenCodeRunArgs({
    major: 2,
    model: "provider/model",
    workspace: "/repo",
    variant: "high",
    prompt: "task",
  })

  assert.deepEqual(args.slice(0, 3), ["run", "--standalone", "--format"])
  assert.deepEqual(args.slice(-3), ["--variant", "high", "task"])
})


test("capability probing wins over version guesses for standalone support", () => {
  const caps = capabilitiesFromHelp("1.18.31", "Usage: opencode run [--standalone] [--format json] [--agent build] [--model x] [--dir .]")
  assert.equal(caps.major, 1)
  assert.equal(caps.supportsStandalone, true)
  const args = buildOpenCodeRunArgs({
    major: 1,
    capabilities: caps,
    model: "provider/model",
    workspace: "/repo",
    prompt: "task",
  })
  assert.equal(args.includes("--standalone"), true)

  const v2WithoutFlag = capabilitiesFromHelp("2.0.0", "Usage: opencode run --format json --agent build --model x --dir .")
  const conservative = buildOpenCodeRunArgs({
    major: 2,
    capabilities: v2WithoutFlag,
    model: "provider/model",
    workspace: "/repo",
    prompt: "task",
  })
  assert.equal(conservative.includes("--standalone"), false)
})
