// V16.7.1 Part 2 integration: the SHIPPED extension aborts a streaming
// generation loop through its REAL hooks.
//
// The defect: a long session degenerated into repetitive narration -- "Let me
// write. Go." -- with no tool call, no file change and no phase advance, for
// thousands of turns. The turn-end guard only observes a COMPLETED assistant
// turn, so by the time it fires the damage is already done. Part 2 observes the
// real token stream (`message_update` / `assistantMessageEvent.type ===
// "text_delta"`) and aborts the CURRENT generation with `ctx.abort()` BEFORE
// `message_end` is reached.
//
// The other V16.7.1 files prove the watchdog MODULE and assert SOURCE strings.
// Neither proves the shipped extension actually: boots, registers the streaming
// hook, classifies the widened scope, and calls `ctx.abort()` exactly once on a
// real delta stream. This file does, by booting the shipped extension against a
// fake `pi` and driving its real handlers with real `message_update` events.
//
// It also proves the guard is NOT over-eager: a long DISTINCT reasoning stream,
// a repetitive status stream interleaved with REAL tool progress, and casual
// chat never abort.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { stripTypeScriptTypes } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { readTrajectory } from "../lib/trajectory.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-7-1-stream-integration-probe")

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
  const probe = path.join(path.dirname(EXTENSION), `__v1671_stream_probe_${process.pid}.mjs`)
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
      bootResult = { module, source }
      return bootResult
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// A fake `pi` that records every registered handler so the driver can fire the
// EXACT events the real host would deliver, in the real order.
// ---------------------------------------------------------------------------
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
    const list = handlers.get(event) || []
    const results = []
    for (const fn of list) results.push(await fn(ev, ctx))
    return results
  }
  return { pi, handlers, fire }
}

// An isolated Git workspace so the admission path and the trajectory writer are
// both exercised exactly as they are in production.
function makeGitWorkspace(tag) {
  const repo = path.join(os.tmpdir(), `ues-v1671-stream-${tag}-${process.pid}-${Date.now()}`)
  mkdirSync(repo, { recursive: true })
  spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" })
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: repo, stdio: "ignore" })
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" })
  return repo
}

const streamDelta = (delta) => ({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta } })

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

// ---------------------------------------------------------------------------
// 1. The core proof: a pathological narration stream aborts EXACTLY once, and
//    the abort happens BEFORE `message_end`.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: the shipped extension aborts a narration loop exactly once before message_end", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("abort")
  const order = []
  let aborts = 0
  const ctx = {
    cwd: repo,
    abort: () => {
      aborts += 1
      order.push("abort")
    },
    ui: { notify: () => {} },
  }
  try {
    // An explicit UES command is unambiguously in scope (Part 3).
    await fire("input", { source: "interactive", text: "/ues-fix the ambiguous root cause across the browser lane" }, ctx)
    await fire("before_agent_start", { task: "fix" }, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 300; i += 1) {
      await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    }
    // The generation never reached `message_end` while the loop was running:
    // only now, after the abort, does the host deliver the terminal event.
    await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Let me write. Go. " }] } }, ctx)
    order.push("message_end")
    await tick()

    assert.equal(aborts, 1, "the streaming loop must abort the current generation EXACTLY once")
    const abortIndex = order.indexOf("abort")
    const endIndex = order.indexOf("message_end")
    assert.ok(abortIndex >= 0, "ctx.abort() must be invoked")
    assert.ok(endIndex >= 0, "the host delivers message_end after the abort")
    assert.ok(abortIndex < endIndex, "the abort must happen BEFORE message_end, not after the turn ends")

    // The structured telemetry the controller journals must be ordered:
    // a warning first, then the confirmed detection.
    const trace = await readTrajectory(repo, "agent-loop-guard")
    const types = trace.events.map((event) => event.type)
    const warnIndex = types.indexOf("agent.stream-loop-warning")
    const detectedIndex = types.indexOf("agent.generation-loop-detected")
    assert.ok(warnIndex >= 0, "a streaming warning must be journalled before the abort")
    assert.ok(detectedIndex >= 0, "the confirmed generation loop must be journalled")
    assert.ok(warnIndex < detectedIndex, "the warning must precede the confirmed detection")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1b. The EXACT production defect trace: a CYCLE of FIVE short phrases, not a
//     single repeated phrase. This is the trace that defeated the pre-fix
//     detector (warns=0, aborts=0), because five phrases is nine normalized
//     tokens and the token-period bound alone can never see it. The shipped
//     extension must still abort the current generation exactly once, before
//     `message_end`, through its real hooks.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: the shipped extension aborts the EXACT 5-phrase cycle before message_end", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("cycle5")
  const order = []
  let aborts = 0
  const ctx = {
    cwd: repo,
    abort: () => {
      aborts += 1
      order.push("abort")
    },
    ui: { notify: () => {} },
  }
  const cycle = ["Let me write.", "Go.", "OK.", "Writing.", "Let me output."]
  try {
    await fire("input", { source: "interactive", text: "/ues-fix the ambiguous root cause across the browser lane" }, ctx)
    await fire("before_agent_start", { task: "fix" }, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 400; i += 1) {
      await fire("message_update", streamDelta(`${cycle[i % cycle.length]} `), ctx)
    }
    await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: cycle.join(" ") }] } }, ctx)
    order.push("message_end")
    await tick()

    assert.equal(aborts, 1, "the 5-phrase cycle must abort the current generation EXACTLY once")
    const abortIndex = order.indexOf("abort")
    const endIndex = order.indexOf("message_end")
    assert.ok(abortIndex >= 0, "ctx.abort() must be invoked")
    assert.ok(endIndex >= 0, "the host delivers message_end after the abort")
    assert.ok(abortIndex < endIndex, "the abort must happen BEFORE message_end")

    const trace = await readTrajectory(repo, "agent-loop-guard")
    const types = trace.events.map((event) => event.type)
    const warnIndex = types.indexOf("agent.stream-loop-warning")
    const detectedIndex = types.indexOf("agent.generation-loop-detected")
    assert.ok(warnIndex >= 0, "the 5-phrase cycle must journal a streaming warning")
    assert.ok(detectedIndex >= 0, "the 5-phrase cycle must journal the confirmed detection")
    assert.ok(warnIndex < detectedIndex, "the warning must precede the confirmed detection")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The abort latch is per-generation: a NEW generation can abort again, but a
//    single generation never aborts twice.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: the once-per-generation latch holds across a new generation", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("latch")
  let aborts = 0
  const ctx = { cwd: repo, abort: () => { aborts += 1 }, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "/ues-fix the ambiguous root cause" }, ctx)
    await fire("before_agent_start", { task: "fix" }, ctx)

    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 300; i += 1) await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    assert.equal(aborts, 1, "generation 1 must abort exactly once")

    // Keep streaming the SAME generation: the latch must not permit a 2nd abort.
    for (let i = 0; i < 300; i += 1) await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    assert.equal(aborts, 1, "a single generation must never abort twice")

    // A new generation resets the window, so a fresh loop aborts again.
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 300; i += 1) await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    assert.equal(aborts, 2, "a fresh generation with a fresh loop must abort again")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. No false positive: a long DISTINCT reasoning stream never aborts.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: a long DISTINCT reasoning stream never aborts", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("distinct")
  let aborts = 0
  const ctx = { cwd: repo, abort: () => { aborts += 1 }, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "/ues-fix the ambiguous root cause" }, ctx)
    await fire("before_agent_start", { task: "fix" }, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 800; i += 1) {
      await fire("message_update", streamDelta(`Considering module ${i}: a distinct analysis step with a different conclusion every time. `), ctx)
    }
    assert.equal(aborts, 0, "distinct substantive reasoning must never be aborted")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. No false positive: repetitive status narration interleaved with REAL tool
//    progress never aborts.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: repetitive status with real tool progress never aborts", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("progress")
  let aborts = 0
  const ctx = { cwd: repo, abort: () => { aborts += 1 }, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "/ues-fix the ambiguous root cause" }, ctx)
    await fire("before_agent_start", { task: "fix" }, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 40; i += 1) {
      await fire("message_update", streamDelta("Let me write. Go. "), ctx)
      // A real tool call between bursts is genuine action progress: it rotates
      // the streaming window so the repeats never accumulate into a loop.
      await fire("tool_call", { toolName: "read", input: { path: "lib/browser-lane.mjs" } }, ctx)
    }
    assert.equal(aborts, 0, "real tool progress must protect a repetitive status stream")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. No false positive: casual chat is NEVER classified, aborted or journalled.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: casual chat is never aborted", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("casual")
  let aborts = 0
  const ctx = { cwd: repo, abort: () => { aborts += 1 }, ui: { notify: () => {} } }
  try {
    await fire("input", { source: "interactive", text: "hello there, how are you today?" }, ctx)
    await fire("before_agent_start", {}, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 300; i += 1) await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    await tick()
    assert.equal(aborts, 0, "casual chat must never be classified or aborted")

    const trace = await readTrajectory(repo, "agent-loop-guard")
    assert.equal(trace.events.length, 0, "casual chat must never be journalled by the loop guard")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Part 3 coverage: a NORMAL `pi` engineering turn (no /ues- command) is in
//    scope and aborts, while a non-engineering turn is not.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration: an admitted normal engineering turn aborts a loop", async () => {
  const { module } = await bootShippedExtension()
  const { pi, fire } = createFakePi()
  module.default(pi)

  const repo = makeGitWorkspace("engineering")
  let aborts = 0
  const ctx = { cwd: repo, abort: () => { aborts += 1 }, ui: { notify: () => {} } }
  try {
    // No `/ues-` prefix: the widened scope must admit this as engineering work.
    await fire("input", { source: "interactive", text: "Implement the new billing module and wire it into the API router in lib/" }, ctx)
    await fire("before_agent_start", {}, ctx)
    await fire("message_start", { message: { role: "assistant" } }, ctx)
    for (let i = 0; i < 300; i += 1) await fire("message_update", streamDelta("Let me write. Go. "), ctx)
    assert.equal(aborts, 1, "a normal engineering turn must be protected by the widened loop guard")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Source contract: the streaming hook exists and the abort lives inside it.
// ---------------------------------------------------------------------------
test("V16.7.1 stream integration source: the shipped handler reads text_delta and aborts inside the stream", async () => {
  const { source } = await bootShippedExtension()
  const updateIndex = source.indexOf('pi.on("message_update"')
  const endIndex = source.indexOf('pi.on("message_end"')
  assert.ok(updateIndex >= 0, "the extension must register message_update")
  assert.ok(endIndex > updateIndex, "message_update must be registered before message_end")
  const abortIndex = source.indexOf("ctx.abort()", updateIndex)
  assert.ok(abortIndex > updateIndex && abortIndex < endIndex, "the abort must live inside the streaming handler")
  assert.ok(source.includes('streamEvent.type !== "text_delta"'), "only text deltas are observed")
})
