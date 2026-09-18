import test from "node:test"
import assert from "node:assert/strict"
import { validManagedMarkdown, validResourceID, validSkillID } from "../lib/ids.mjs"

test("resource ID rule rejects underscores and uppercase in managed IDs", () => {
  assert.equal(validResourceID("a"), true)
  assert.equal(validResourceID("a-b-c"), true)
  assert.equal(validResourceID("my_cmd"), false)
  assert.equal(validResourceID("MyAgent"), false)
  assert.equal(validResourceID(""), false)

  assert.equal(validSkillID("ues-repo-explorer"), true)
  assert.equal(validSkillID("ues-my_cmd"), false)

  assert.equal(validManagedMarkdown("ues-good-cmd.md"), true)
  assert.equal(validManagedMarkdown("ues-MyAgent.md"), false)
  assert.equal(validManagedMarkdown("ues-good-cmd"), false)
})