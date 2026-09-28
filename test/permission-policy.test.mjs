import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  evaluatePermissionRules,
  permissionPatternMatches,
  PermissionPolicyStore,
  toolPermissionRequest,
} from "../lib/permission-policy.mjs"

test("last matching rule wins", () => {
  const result = evaluatePermissionRules([
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "git status *", effect: "allow" },
    { action: "shell", resource: "git push *", effect: "deny" },
  ], { action: "shell", resource: "git push origin main" })
  assert.equal(result.effect, "deny")
  assert.equal(result.decisions[0].matchedRule.index, 2)
})

test("shell pattern ending in space-star also matches no-argument command", () => {
  assert.equal(permissionPatternMatches("git status *", "git status", { shell: true }), true)
  assert.equal(permissionPatternMatches("git status *", "git status --short", { shell: true }), true)
})

test("windows matching normalizes slashes and is case-insensitive", () => {
  const result = evaluatePermissionRules([
    { action: "edit", resource: "packages/docs/*.mdx", effect: "deny" },
  ], { action: "EDIT", resource: "PACKAGES\\DOCS\\Guide.MDX" }, { platform: "win32" })
  assert.equal(result.effect, "deny")
})

test("multiple resources aggregate deny before ask before allow", () => {
  const result = evaluatePermissionRules([
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "*.env", effect: "deny" },
  ], { action: "edit", resources: ["src/a.ts", ".env"] })
  assert.equal(result.effect, "deny")
})

test("UES compatibility default is allow when no rule matches", () => {
  const result = evaluatePermissionRules([], { action: "shell", resource: "npm test" })
  assert.equal(result.effect, "allow")
})

test("tool request mapping uses OpenCode-style actions", () => {
  assert.deepEqual(
    toolPermissionRequest("powershell", { command: "git status --short" }),
    { action: "shell", resources: ["git status --short"] },
  )
  assert.deepEqual(
    toolPermissionRequest("write", { path: "src/a.ts" }),
    { action: "edit", resources: ["src/a.ts"] },
  )
})

test("agent rules append after global rules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    defaultEffect: "allow",
    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    agents: {
      "ues-reviewer": {
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      },
    },
  }))
  const store = new PermissionPolicyStore(file)
  const result = await store.evaluate(
    { action: "edit", resources: ["src/a.ts"] },
    { agent: "ues-reviewer" },
  )
  assert.equal(result.decision.effect, "deny")
  assert.equal(result.decision.decisions[0].matchedRule.index, 1)
})

test("store hot-reloads when config file changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    permissions: [{ action: "shell", resource: "git push *", effect: "deny" }],
  }))
  const store = new PermissionPolicyStore(file)
  const before = await store.evaluate({ action: "shell", resources: ["git push origin main"] })
  assert.equal(before.decision.effect, "deny")

  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, JSON.stringify({
    permissions: [{ action: "shell", resource: "git push *", effect: "allow" }],
  }))
  const after = await store.evaluate({ action: "shell", resources: ["git push origin main"] })
  assert.equal(after.decision.effect, "allow")
})
