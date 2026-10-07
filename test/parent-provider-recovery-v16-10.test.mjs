// V16.10 provider empty-response recovery: new-state proof regression.
//
// The defect (reproduced live): the parent `agent_before_settle` handler
// recovers an empty provider response with `{ continue: true }` and a bounded
// budget (`PARENT_PROVIDER_RECOVERY_MAX_TOTAL = 3`). But the budget counters were
// reset at EVERY run boundary (`before_agent_start` else-branch and `agent_end`).
// A flaky provider that keeps returning an empty response therefore reset its own
// budget on each run boundary, so the "bounded" recovery degenerated into an
// unbounded two-step loop on UNCHANGED state -- the live symptom was ~25
// identical `ues-parent-provider-recovery` injections.
//
// The fix: the provider recovery budget is reset ONLY on a genuine new-state
// proof -- a new interactive human turn (`input`) or a substantive assistant
// response (`message_end` with non-empty text and no error). A run boundary is
// NOT new state.
//
// This file boots the SHIPPED extension against a fake `pi` and drives its REAL
// handlers in the REAL order, so it proves runtime behavior (the existing
// `pi-package.test.mjs` / `v15-runtime.test.mjs` only assert SOURCE strings).

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { stripTypeScriptTypes } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-10-provider-recovery-probe")

const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n")

let bootResult = null
async function bootShippedExtension() {
  if (bootResult) return bootResult
  const probe = path.join(path.dirname(EXTENSION), `__v1610_provider_recovery_probe_${process.pid}.mjs`)
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs")
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(stub, TYPEBOX_STUB, "utf8")
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    })
    const stubUrl = pathToFileURL(stub).href
    source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`)
    writeFileSync(probe, source, "utf8")
    try {
      const module = await import(pathToFileURL(probe).href)
      bootResult = { module }
      return bootResult
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

function createFakePi() {
  const handlers = new Map()
  const pi = {
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    registerTool: () => () => {},
    addTool: () => () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
    setSessionName: () => {},
    ui: { notify: () => {}, setTitle: () => {} },
    command: () => {},
    registerCommand: () => {},
    getSystemPrompt: () => "",
    appendEntry: () => {},
  }
  const fire = async (event, ev, ctx) => {
    const results = []
    for (const fn of handlers.get(event) || []) results.push(await fn(ev, ctx))
    return results
  }
  return { pi, fire }
}

function makeGitWorkspace(tag) {
  const repo = path.join(os.tmpdir(), `ues-v1610-provider-recovery-${tag}-${process.pid}-${Date.now()}`)
  mkdirSync(repo, { recursive: true })
  spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" })
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: repo, stdio: "ignore" })
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" })
  return repo
}

const recoveryMessages = (results) => {
  const out = []
  for (const result of results) {
    if (!result || result.continue !== true) continue
    for (const entry of result.entries || []) {
      if (entry?.customType === "ues-parent-provider-recovery") out.push(entry)
    }
  }
  return out
}

// One empty-provider run: complete a tool call, then the assistant returns an
// empty response with `stopReason: "stop"`. This is the exact unchanged state
// that previously looped forever.
async function emptyProviderRun(fire, ctx, { withAgentEnd = true } = {}) {
  await fire("before_agent_start", {}, ctx)
  await fire("tool_call", { toolName: "read", input: { path: "lib/a.mjs" } }, ctx)
  await fire("tool_result", { toolName: "read", input: { path: "lib/a.mjs" }, content: [{ type: "text", text: "ok" }] }, ctx)
  await fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
  const results = await fire("agent_before_settle", { entries: [] }, ctx)
  if (withAgentEnd) await fire("agent_end", {}, ctx)
  return results
}

test("V16.10 provider recovery: unchanged empty-provider state stays bounded across run boundaries", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)
  const repo = makeGitWorkspace("bounded")
  const ctx = { cwd: repo, abort: () => {}, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "what is in lib/a.mjs?" }, ctx)
    let recoveries = 0
    let totals = []
    // Ten unchanged empty-provider runs, each fully ended (`agent_end` between).
    // Before the fix this produced 10 recoveries (unbounded); after it the
    // consecutive cap (PARENT_PROVIDER_RECOVERY_MAX_CONSECUTIVE = 1) stops it at
    // exactly one, because the run boundary no longer resets the budget.
    for (let i = 0; i < 10; i += 1) {
      const msgs = recoveryMessages(await emptyProviderRun(fire, ctx, { withAgentEnd: true }))
      recoveries += msgs.length
      for (const msg of msgs) totals.push(Number(msg.details?.totalAttempts))
    }
    assert.equal(recoveries, 1, "recovery must stay bounded across agent_end run boundaries")
    assert.deepEqual(totals, [1], "attempt accounting must not reset on every run boundary")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("V16.10 provider recovery: a new human turn is new-state proof that resets the budget", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)
  const repo = makeGitWorkspace("newturn")
  const ctx = { cwd: repo, abort: () => {}, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "what is in lib/a.mjs?" }, ctx)
    // Exhaust the bounded budget.
    let recoveries = 0
    for (let i = 0; i < 6; i += 1) {
      recoveries += recoveryMessages(await emptyProviderRun(fire, ctx)).length
    }
    assert.equal(recoveries, 1, "budget must exhaust")

    // A genuine new human turn is new state: recovery is allowed again and the
    // incident counter starts fresh.
    await fire("input", { source: "interactive", text: "now check lib/b.mjs" }, ctx)
    const afterNewTurn = recoveryMessages(await emptyProviderRun(fire, ctx))
    assert.equal(afterNewTurn.length, 1, "a new human turn must reset the provider recovery budget")
    assert.equal(Number(afterNewTurn[0].details?.totalAttempts), 1, "the new incident starts at attempt 1")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("V16.10 provider recovery: a substantive response clears the consecutive incident budget", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)
  const repo = makeGitWorkspace("substantive")
  const ctx = { cwd: repo, abort: () => {}, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "what is in lib/a.mjs?" }, ctx)
    let recoveries = 0
    for (let i = 0; i < 6; i += 1) {
      recoveries += recoveryMessages(await emptyProviderRun(fire, ctx)).length
    }
    assert.equal(recoveries, 1, "budget must exhaust")

    // A real answer proves the incident recovered: it clears the CONSECUTIVE
    // incident counter (but not the run TOTAL, so an alternating flaky provider
    // is still bounded by MAX_TOTAL). The next empty response may recover again.
    await fire("before_agent_start", {}, ctx)
    await fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The file exports a helper." }] } }, ctx)
    await fire("agent_end", {}, ctx)

    const afterRecovery = recoveryMessages(await emptyProviderRun(fire, ctx))
    assert.equal(afterRecovery.length, 1, "a substantive assistant response must clear the consecutive incident budget")
    assert.equal(Number(afterRecovery[0].details?.totalAttempts), 2, "the run total keeps accumulating (bounded by MAX_TOTAL)")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("V16.10 provider recovery: a substantive response without error does not itself trigger a continuation", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)
  const repo = makeGitWorkspace("noop")
  const ctx = { cwd: repo, abort: () => {}, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "what is in lib/a.mjs?" }, ctx)
    await fire("before_agent_start", {}, ctx)
    await fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Here is the answer." }] } }, ctx)
    const results = await fire("agent_before_settle", { entries: [] }, ctx)
    assert.equal(recoveryMessages(results).length, 0, "a normal completed turn must never request a recovery continuation")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
