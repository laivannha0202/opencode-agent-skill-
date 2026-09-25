import test from "node:test"
import assert from "node:assert/strict"
import { inferTaskClass, recordPerformanceOutcome, rerankCapabilitySelection } from "../lib/model-performance.mjs"
test("V12 task classification detects repo-scale work", () => {
  assert.equal(inferTaskClass("Refactor the whole repo across many modules"), "repo-scale")
})
test("empirical routing can prefer a proven model over a slightly higher static score", () => {
  const selection = { candidates:[{id:"provider/a",eligible:true,score:80},{id:"provider/b",eligible:true,score:77}], selected:{id:"provider/a",eligible:true,score:80} }
  let history = {}
  for (let i=0;i<6;i+=1) {
    history = recordPerformanceOutcome(history,{model:"provider/a",taskClass:"debugging",passed:i<2,retries:2})
    history = recordPerformanceOutcome(history,{model:"provider/b",taskClass:"debugging",passed:true,retries:0})
  }
  const reranked = rerankCapabilitySelection(selection,history,{taskClass:"debugging",minSamples:3})
  assert.equal(reranked.selected.id,"provider/b")
})

test("empirical routing does not rerank from a single noisy observation", () => {
  const selection = {
    candidates: [{ id: "provider/a", eligible: true, score: 80 }, { id: "provider/b", eligible: true, score: 77 }],
    selected: { id: "provider/a", eligible: true, score: 80 },
  }
  const history = recordPerformanceOutcome({}, { model: "provider/b", taskClass: "debugging", passed: true })
  const reranked = rerankCapabilitySelection(selection, history, { taskClass: "debugging", minSamples: 3 })
  assert.equal(reranked.selected.id, "provider/a")
})

test("V14.2 default empirical routing waits for the stronger sample floor", () => {
  const selection = {
    candidates: [
      { id: "provider/a", eligible: true, score: 80 },
      { id: "provider/b", eligible: true, score: 77 },
    ],
    selected: { id: "provider/a", eligible: true, score: 80 },
  }
  let history = {}
  for (let i = 0; i < 6; i += 1) {
    history = recordPerformanceOutcome(history, {
      model: "provider/b",
      taskClass: "debugging",
      passed: true,
      retries: 0,
    })
  }
  const reranked = rerankCapabilitySelection(selection, history, { taskClass: "debugging" })
  assert.equal(reranked.selected.id, "provider/a")
  assert.equal(reranked.candidates.find((item) => item.id === "provider/b").empiricalConfidence < 1, true)
})
