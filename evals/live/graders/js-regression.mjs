import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

const workspace = process.env.UES_EVAL_WORKSPACE
if (!workspace) {
  console.error("UES_EVAL_WORKSPACE is required")
  process.exit(2)
}

const target = path.join(workspace, "src", "discount.mjs")
const mod = await import(pathToFileURL(target).href + `?eval=${Date.now()}`)
assert.equal(typeof mod.calculateDiscount, "function")

const close = (actual, expected) => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${actual} to be close to ${expected}`,
  )
}

close(mod.calculateDiscount(100, 20), 80)
close(mod.calculateDiscount(199.99, 15), 169.9915)
close(mod.calculateDiscount(0, 50), 0)
close(mod.calculateDiscount(42, 0), 42)
close(mod.calculateDiscount(42, 100), 0)

for (const args of [[NaN, 10], [100, Infinity], ["100", 10]]) {
  assert.throws(() => mod.calculateDiscount(...args), TypeError)
}

for (const percent of [-1, 101]) {
  assert.throws(() => mod.calculateDiscount(100, percent), RangeError)
}

console.log("hidden grader passed")
