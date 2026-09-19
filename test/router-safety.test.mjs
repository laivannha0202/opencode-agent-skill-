import test from "node:test"
import assert from "node:assert/strict"
import { destructiveShellRisk } from "../global-config/plugins/ues-router/safety.js"

test("runtime safety gate recognizes destructive or external side-effect commands", () => {
  assert.equal(destructiveShellRisk("git status").risky, false)
  assert.equal(destructiveShellRisk("npm test").risky, false)
  assert.equal(destructiveShellRisk("git reset --hard HEAD~1").id, "git-force")
  assert.equal(destructiveShellRisk("npm publish --access public").id, "publish")
  assert.equal(destructiveShellRisk("terraform destroy -auto-approve").id, "deployment")
  assert.equal(destructiveShellRisk("DROP TABLE users;").id, "database-drop")
})
