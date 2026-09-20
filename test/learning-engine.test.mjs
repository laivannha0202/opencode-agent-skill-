import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acceptLearning, analyzeEvalTraces, promoteLearning, readLearningState, relevantAcceptedLearnings, saveLearningAnalysis } from "../lib/learning-engine.mjs"

test("learning loop proposes and accepts evidence-backed eval lessons", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-learning-"))
  try {
    const evalDir = path.join(root, ".ues-evals")
    await mkdir(evalDir, { recursive: true })
    await writeFile(path.join(evalDir, "sample.json"), JSON.stringify({
      results: [{
        task: "checkout",
        mode: "ues",
        agentExit: 0,
        graderExit: 1,
        orchestration: { required: true, valid: false },
        telemetry: { parseErrors: 0 },
      }],
    }))
    const analysis = await analyzeEvalTraces(evalDir)
    assert.ok(analysis.proposals.some((item) => item.key === "grader-failure"))
    const state = await saveLearningAnalysis(root, analysis)
    const accepted = await acceptLearning(root, state.proposals[0].id)
    assert.equal(accepted.status, "accepted-awaiting-shadow")
    assert.equal((await readLearningState(root)).accepted.length, 1)
    assert.deepEqual(await relevantAcceptedLearnings(root, "checkout failure"), [])

    await assert.rejects(
      promoteLearning(root, accepted.id, {
        baselinePassRate: 0.5,
        candidatePassRate: 0.5,
        samples: 4,
      }),
      /measured shadow benchmark improvement/,
    )

    const promoted = await promoteLearning(root, accepted.id, {
      baselinePassRate: 0.5,
      candidatePassRate: 0.75,
      samples: 4,
      report: "shadow-eval.json",
    })
    assert.equal(promoted.status, "promoted")
    assert.equal(promoted.shadowValidation.delta, 0.25)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
