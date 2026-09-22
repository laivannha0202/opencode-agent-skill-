import test from "node:test"
import assert from "node:assert/strict"
import {
  budgetToolResult,
  classifyProviderFailure,
  createRuntimeGuard,
  providerRecoveryPlan,
  progressWatchdogDecision,
} from "../global-config/plugins/ues-router/runtime-guard.js"

test("duplicate exploration is blocked only after repeated equivalent calls", () => {
  const guard = createRuntimeGuard({ duplicateLimit: 3 })
  const base = {
    sessionID: "s1",
    tool: "grep",
    input: { pattern: "TODO", path: "src" },
    cwd: "/repo",
    workspaceSignal: "clean-a",
  }

  assert.equal(guard.before({ ...base, callID: "1", now: 1 }).blocked, false)
  guard.after({ ...base, callID: "1", status: "completed", result: "a", now: 2 })
  assert.equal(guard.before({ ...base, callID: "2", now: 3 }).blocked, false)
  guard.after({ ...base, callID: "2", status: "completed", result: "a", now: 4 })
  assert.equal(guard.before({ ...base, callID: "3", now: 5 }).blocked, false)
  guard.after({ ...base, callID: "3", status: "completed", result: "a", now: 6 })

  const blocked = guard.before({ ...base, callID: "4", now: 7 })
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.code, "UES_DUPLICATE_TOOL")

  const changed = guard.before({ ...base, callID: "5", workspaceSignal: "changed-b", now: 8 })
  assert.equal(changed.blocked, false)
})

test("loop detector blocks repeated no-progress exploration and compaction resets it", () => {
  const guard = createRuntimeGuard({ duplicateLimit: 99, loopLimit: 4 })
  for (let index = 0; index < 5; index += 1) {
    const callID = String(index)
    const before = guard.before({
      sessionID: "loop",
      tool: "read",
      input: { file: "src/a.js" },
      cwd: "/repo",
      workspaceSignal: "same",
      callID,
      now: index * 2 + 1,
    })
    assert.equal(before.blocked, false)
    guard.after({
      sessionID: "loop",
      tool: "read",
      input: { file: "src/a.js" },
      cwd: "/repo",
      workspaceSignal: "same",
      callID,
      status: "completed",
      result: "unchanged evidence",
      now: index * 2 + 2,
    })
  }

  assert.equal(guard.snapshot("loop").loopBlocked, true)
  const blocked = guard.before({
    sessionID: "loop",
    tool: "glob",
    input: { pattern: "**/*.js" },
    workspaceSignal: "same",
    callID: "next",
    now: 20,
  })
  assert.equal(blocked.code, "UES_LOOP_DETECTED")

  guard.compacted("loop", 21)
  assert.equal(guard.snapshot("loop").loopBlocked, false)
  assert.equal(
    guard.before({
      sessionID: "loop",
      tool: "read",
      input: { file: "src/a.js" },
      workspaceSignal: "same",
      callID: "after-compact",
      now: 22,
    }).blocked,
    false,
  )
})

test("tool output budget truncates oversized exploration output with evidence metadata", () => {
  const result = budgetToolResult("grep", {
    title: "grep",
    output: Array.from({ length: 500 }, (_, i) => `line-${i} ${"x".repeat(80)}`).join("\n"),
    metadata: {},
  }, { maxChars: 4000, maxLines: 80 })

  assert.equal(result.metadata.uesTruncated, true)
  assert.ok(result.metadata.uesOriginalLines >= 500)
  assert.ok(result.output.length <= 4000)
  assert.match(result.output, /UES/)
})

test("provider recovery retries fresh once then escalates configured model", () => {
  assert.equal(classifyProviderFailure({ message: "provider returned no content" }), "NO_TOKEN")
  assert.equal(classifyProviderFailure({ status: 429, message: "rate limit" }), "RATE_LIMIT")
  assert.equal(classifyProviderFailure({ status: 401, message: "unauthorized" }), "AUTH")
  assert.equal(classifyProviderFailure({ message: "maximum context length exceeded" }), "CONTEXT_TOO_LARGE")

  assert.equal(
    providerRecoveryPlan("NO_TOKEN", 1, { hasEscalationModel: true }).action,
    "fresh-session-same-model",
  )
  assert.equal(
    providerRecoveryPlan("NO_TOKEN", 2, { hasEscalationModel: true }).action,
    "fresh-session-escalated-model",
  )
  assert.equal(providerRecoveryPlan("AUTH", 1).retry, false)
  assert.equal(providerRecoveryPlan("CONTEXT_TOO_LARGE", 1).action, "compact-context")
})


test("no-progress watchdog stalls idle sessions but exempts an active long-running tool", () => {
  const idle = progressWatchdogDecision(
    { lastProgressAt: 1_000, activeToolCalls: 0 },
    61_500,
    60_000,
  )
  assert.equal(idle.stalled, true)
  assert.equal(idle.reason, "no-progress")

  const active = progressWatchdogDecision(
    { lastProgressAt: 1_000, activeToolCalls: 1 },
    180_000,
    60_000,
  )
  assert.equal(active.stalled, false)
  assert.equal(active.reason, "tool-active")
})
