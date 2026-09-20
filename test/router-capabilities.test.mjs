import test from "node:test"
import assert from "node:assert/strict"
import { runtimeCapabilities } from "../global-config/plugins/ues-router/capabilities.js"

test("runtime capability probing fails closed when fresh dispatch APIs are missing", () => {
  const caps = runtimeCapabilities({ session: { create() {}, prompt() {} } })
  assert.equal(caps.sessionCreate, true)
  assert.equal(caps.sessionWait, false)
  assert.equal(caps.freshDispatch, false)
})

test("runtime capability probing recognizes the complete fresh dispatch surface", () => {
  const fn = () => {}
  const caps = runtimeCapabilities({
    session: {
      create: fn,
      prompt: fn,
      wait: fn,
      interrupt: fn,
      context: fn,
      switchAgent: fn,
      switchModel: fn,
      hook: fn,
    },
    permission: { hook: fn },
  })
  assert.equal(caps.freshDispatch, true)
  assert.equal(caps.modelSwitch, true)
  assert.equal(caps.sessionInterrupt, true)
  assert.equal(caps.sessionHook, true)
  assert.equal(caps.permissionHook, true)
})

test("fresh dispatch fails closed without session interrupt", () => {
  const fn = () => {}
  const caps = runtimeCapabilities({
    session: {
      create: fn,
      prompt: fn,
      wait: fn,
      context: fn,
      switchAgent: fn,
    },
  })
  assert.equal(caps.sessionInterrupt, false)
  assert.equal(caps.freshDispatch, false)
})
