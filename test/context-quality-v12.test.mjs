import test from "node:test"
import assert from "node:assert/strict"
import { measureContextQuality } from "../lib/context-quality.mjs"
test("V12 context quality reports required-file recall and irrelevant ratio", () => {
  const quality = measureContextQuality({files:{modify:["src/a.js","src/b.js"]}}, {excerpts:[
    {path:"src/a.js",role:"declared"},{path:"src/b.js",role:"declared"},{path:"src/noise.js",role:"reference"},
  ]})
  assert.equal(quality.requiredFileRecall,1)
  assert.equal(quality.requiredFileHits.length,2)
  assert.equal(quality.irrelevantFiles.includes("src/noise.js"),true)
})
