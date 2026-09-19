import test from "node:test"
import assert from "node:assert/strict"
import { adaptAgentForOpenCode, parseOpenCodeMajor } from "../lib/opencode-compat.mjs"

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
