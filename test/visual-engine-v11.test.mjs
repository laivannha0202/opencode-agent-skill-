import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { comparePngBuffers, cropPngFile, encodeRgbaPng } from "../lib/png-diff.mjs"
import { buildVisualRepairPlan, createGeometryReceipt, responsiveViewportMatrix, validateVisualSpec } from "../lib/visual-spec.mjs"

test("V11 geometry receipt proves exact element placement within tolerance", () => {
  const spec = {
    viewport: { width: 1440, height: 900 },
    elements: [{ id: "buy", x: [100, 110], y: 200, width: 180, height: 48, tolerance: { position: 4, size: 2 } }],
  }
  assert.equal(validateVisualSpec(spec).valid, true)
  const pass = createGeometryReceipt(spec, [{ id: "buy", x: 105, y: 202, width: 181, height: 48 }])
  assert.equal(pass.verdict, "PASS")
  const fail = createGeometryReceipt(spec, [{ id: "buy", x: 150, y: 202, width: 181, height: 48 }])
  assert.equal(fail.verdict, "FAIL")
  assert.deepEqual(buildVisualRepairPlan(fail).failedElementIDs, ["buy"])
  assert.equal(responsiveViewportMatrix().length, 4)
})

test("V11 PNG diff locates changed pixels and can crop the failure region", async () => {
  const base = Buffer.from([
    0,0,0,255, 0,0,0,255,
    0,0,0,255, 0,0,0,255,
  ])
  const changed = Buffer.from(base)
  changed.set([255,255,255,255], 12)
  const expected = encodeRgbaPng({ width: 2, height: 2, rgba: base })
  const actual = encodeRgbaPng({ width: 2, height: 2, rgba: changed })
  const diff = comparePngBuffers(expected, actual, { threshold: 0 })
  assert.equal(diff.differentPixels, 1)
  assert.deepEqual(diff.bounds, { x: 1, y: 1, width: 1, height: 1 })

  const root = await mkdtemp(path.join(os.tmpdir(), "ues-png-"))
  try {
    const input = path.join(root, "input.png")
    const output = path.join(root, "crop.png")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(input, actual)
    const crop = await cropPngFile(input, output, diff.bounds)
    assert.equal(crop.width, 1)
    assert.equal(crop.height, 1)
    assert.ok((await readFile(output)).length > 20)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V11 PNG decoder rejects unsafe dimensions before decompression", () => {
  const rgba = Buffer.alloc(4)
  const png = encodeRgbaPng({ width: 1, height: 1, rgba })
  const unsafe = Buffer.from(png)
  unsafe.writeUInt32BE(100000, 16)
  unsafe.writeUInt32BE(100000, 20)
  assert.throws(() => comparePngBuffers(unsafe, unsafe), /safety budget/)
})
