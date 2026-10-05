import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues-loop-recovery.ts")

async function loadCompat() {
  const temp = path.join(os.tmpdir(), `ues-loop-recovery-${process.pid}-${Date.now()}.mjs`)
  let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
    mode: "strip",
    sourceUrl: "pi/extensions/ues-loop-recovery.ts",
  })
  const watchdogUrl = pathToFileURL(path.join(ROOT, "lib", "agent-progress-watchdog.mjs")).href
  source = source.replace('../../lib/agent-progress-watchdog.mjs', watchdogUrl)
  writeFileSync(temp, source, "utf8")
  try {
    return await import(pathToFileURL(temp).href)
  } finally {
    rmSync(temp, { force: true })
  }
}

function fakePi() {
  const handlers = new Map()
  const sent = []
  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    sendMessage(message, options) {
      sent.push({ message, options })
    },
  }
  return {
    pi,
    sent,
    async fire(event, payload = {}, ctx = {}) {
      const results = []
      for (const fn of handlers.get(event) || []) results.push(await fn(payload, ctx))
      return results
    },
  }
}

const delta = (text) => ({
  message: { role: "assistant" },
  assistantMessageEvent: { type: "text_delta", delta: text },
})

async function driveStreamLoop(host) {
  await host.fire("message_start", { message: { role: "assistant" } })
  for (let i = 0; i < 320; i += 1) {
    await host.fire("message_update", delta("Let me write. Go. "))
  }
  await host.fire("message_end", {
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "Let me write. Go." }],
    },
  })
  await host.fire("agent_settled")
}

test("V16.7.1 compat: an aborted streaming loop receives one bounded fresh continuation", async () => {
  const { default: install } = await loadCompat()
  const host = fakePi()
  install(host.pi)

  await host.fire("input", { source: "interactive", text: "/ues-fix the code bug" })
  await host.fire("before_agent_start")
  await driveStreamLoop(host)

  assert.equal(host.sent.length, 1)
  assert.equal(host.sent[0].options?.triggerTurn, true)
  assert.equal(host.sent[0].message?.customType, "ues-agent-loop-recovery")
  assert.match(host.sent[0].message?.content || "", /Do not restart the task/)
  assert.match(host.sent[0].message?.content || "", /next concrete action/i)
})

test("V16.7.1 compat: a manual/non-loop abort does not auto-restart the model", async () => {
  const { default: install } = await loadCompat()
  const host = fakePi()
  install(host.pi)

  await host.fire("input", { source: "interactive", text: "/ues-fix the code bug" })
  await host.fire("message_start", { message: { role: "assistant" } })
  await host.fire("message_update", delta("I found the root cause in the cache key and will inspect its caller."))
  await host.fire("message_end", {
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "I found the root cause in the cache key." }],
    },
  })
  await host.fire("agent_settled")

  assert.equal(host.sent.length, 0)
})

test("V16.7.1 compat: automatic recovery is bounded and fails closed", async () => {
  const { default: install } = await loadCompat()
  const host = fakePi()
  install(host.pi)

  await host.fire("input", { source: "interactive", text: "/ues-fix the code bug" })

  await driveStreamLoop(host)
  await host.fire("before_agent_start")
  await driveStreamLoop(host)
  await host.fire("before_agent_start")
  await driveStreamLoop(host)

  assert.equal(host.sent.length, 3)
  assert.equal(host.sent[0].options?.triggerTurn, true)
  assert.equal(host.sent[1].options?.triggerTurn, true)
  assert.equal(host.sent[2].options?.triggerTurn, false)
  assert.equal(host.sent[2].message?.customType, "ues-agent-loop-unrecovered")
  assert.match(host.sent[2].message?.content || "", /working state was not reset or discarded/i)
})

test("V16.7.1 compat: completed-turn recovery uses Pi BoundaryResult entries + continue", async () => {
  const { default: install } = await loadCompat()
  const host = fakePi()
  install(host.pi)

  await host.fire("input", { source: "interactive", text: "/ues-fix the code bug" })
  for (let i = 0; i < 6; i += 1) {
    await host.fire("message_start", { message: { role: "assistant" } })
    await host.fire("message_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Let me write. Go." }],
      },
    })
  }

  const results = await host.fire("agent_before_settle", { entries: [] })
  const boundary = results.find((value) => value?.entries)
  assert.ok(boundary, "compat handler must return a real BoundaryResult")
  assert.equal(boundary.continue, true)
  assert.equal(boundary.entries.at(-1)?.type, "custom_message")
  assert.equal(boundary.entries.at(-1)?.customType, "ues-agent-loop-recovery")
  assert.equal(Object.hasOwn(boundary, "contextEdit"), false)
})

test("V16.7.1 package keeps the primary UES controller first and loads the compat extension", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  assert.equal(pkg.pi.extensions[0], "./pi/extensions/ues.ts")
  assert.ok(pkg.pi.extensions.includes("./pi/extensions/ues-loop-recovery.ts"))
})
