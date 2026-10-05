// V16.7.1 process/timeout hygiene regression.
//
// The defect: `releaseWebLane()`, `releaseBrowserLane()` and
// `releaseManagedBrowserWorker()` were DEFINED but NEVER CALLED from the run
// path. Every completed, failed or timed-out controller run therefore leaked its
// managed browser lane, its persistent browser worker and its exclusive profile
// lease. A parent timeout could leave a zombie worker holding a profile lock.
//
// This file proves the fix the way the runtime uses it:
//
//   1. The SHIPPED extension is type-stripped and really imported (boot proof).
//   2. `releaseRunScopedResources` -- the SAME exported helper the controller
//      runs in its `finally` -- is called directly and asserted to be a no-op
//      that NEVER throws for an unknown run (idempotent, null-tolerant).
//   3. A missing run id is rejected explicitly instead of releasing an
//      arbitrary lane.
//   4. The source is asserted to call the helper from a `finally`, so the
//      release runs on the throw/timeout path too, not only on the happy path.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-7-1-teardown-probe")
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
  const probe = path.join(path.dirname(EXTENSION), `__v1671_teardown_probe_${process.pid}.mjs`)
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

test("V16.7.1 teardown: the shipped extension exports releaseRunScopedResources", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(
    typeof module.releaseRunScopedResources,
    "function",
    "the teardown helper must be exported so the release contract is testable",
  )
})

test("V16.7.1 teardown: releasing an unknown run is a no-op that never throws", async () => {
  const { module } = await bootShippedExtension()
  // The maps are empty for this run id; every step must tolerate that and the
  // helper must resolve (not reject) so a `finally` can always await it.
  const result = await module.releaseRunScopedResources(process.cwd(), "no-such-run-" + process.pid)
  assert.equal(result.released, true)
  assert.deepEqual(result.steps, ["web-lane", "browser-lane", "browser-worker"])
})

test("V16.7.1 teardown: a missing run id is refused instead of releasing an arbitrary lane", async () => {
  const { module } = await bootShippedExtension()
  const result = await module.releaseRunScopedResources(process.cwd(), "")
  assert.equal(result.released, false)
  assert.equal(result.reason, "missing-run-id")
})

test("V16.7.1 teardown: releasing twice is idempotent", async () => {
  const { module } = await bootShippedExtension()
  const runId = "idempotent-" + process.pid
  const first = await module.releaseRunScopedResources(process.cwd(), runId)
  const second = await module.releaseRunScopedResources(process.cwd(), runId)
  assert.equal(first.released, true)
  assert.equal(second.released, true)
})

test("V16.7.1 teardown source: the controller releases run-scoped resources from a finally", async () => {
  const { source } = await bootShippedExtension()
  // The helper is invoked inside a `finally` block, so a throw or a parent
  // timeout/abort still releases the worker and the profile lease.
  assert.match(
    source,
    /}\s*finally\s*\{[\s\S]{0,1200}await releaseRunScopedResources\(cwd, runScopedTraceID\)/,
    "the controller must call releaseRunScopedResources from a finally block",
  )
  // The historical leak: the three release functions existed but were never
  // called from the run path. The helper must compose all three.
  assert.match(source, /await releaseWebLane\(cwd, traceID\)/, "releaseWebLane must be called by the helper")
  assert.match(source, /await releaseBrowserLane\(cwd, traceID\)/, "releaseBrowserLane must be called by the helper")
  assert.match(
    source,
    /await releaseManagedBrowserWorker\(cwd, traceID\)/,
    "releaseManagedBrowserWorker must be called by the helper",
  )
  // `runScopedTraceID` must be assigned before the finally can run.
  assert.match(source, /runScopedTraceID = traceID/, "the trace id must be captured for the finally block")
})
