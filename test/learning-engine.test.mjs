import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acceptLearning, analyzeEvalTraces, promoteLearning, readLearningState, relevantAcceptedLearnings, saveLearningAnalysis } from "../lib/learning-engine.mjs"

async function writeMatrix(file, baselinePassRate, uesPassRate, total = 24) {
  const baselinePassed = Math.round(baselinePassRate * total)
  const uesPassed = Math.round(uesPassRate * total)
  const pairedResults = []
  for (let trial = 1; trial <= total; trial += 1) {
    pairedResults.push({
      suite: "live",
      task: "task-" + trial,
      trial: 1,
      mode: "baseline",
      passed: trial <= baselinePassed,
      durationMs: 100,
    })
    pairedResults.push({
      suite: "live",
      task: "task-" + trial,
      trial: 1,
      mode: "ues",
      passed: trial <= uesPassed,
      durationMs: 110,
    })
  }
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    kind: "ues-benchmark-matrix",
    model: "test/provider-model",
    suites: ["live"],
    coverageComplete: true,
    finishedAt: new Date().toISOString(),
    pairedResults,
    summary: {
      modes: {
        baseline: { passed: baselinePassed, total, passRate: baselinePassRate },
        ues: { passed: uesPassed, total, passRate: uesPassRate },
      },
      passRateDelta: uesPassRate - baselinePassRate,
    },
  }, null, 2))
}

test("learning loop promotes only from an accepted benchmark artifact with measured improvement", async () => {
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

    await assert.rejects(
      promoteLearning(root, state.proposals[0].id, { report: path.join(evalDir, "missing.json") }),
      /explicitly accepted/,
    )

    const accepted = await acceptLearning(root, state.proposals[0].id)
    assert.equal(accepted.status, "accepted-awaiting-shadow")
    assert.equal((await readLearningState(root)).accepted.length, 1)
    assert.deepEqual(await relevantAcceptedLearnings(root, "checkout failure"), [])

    await assert.rejects(promoteLearning(root, accepted.id, {}), /requires --report/)

    const noGain = path.join(evalDir, "matrix-no-gain.json")
    await writeMatrix(noGain, 0.5, 0.5)
    await assert.rejects(
      promoteLearning(root, accepted.id, { report: noGain }),
      /measured shadow benchmark improvement/,
    )

    const improved = path.join(evalDir, "matrix-improved.json")
    await writeMatrix(improved, 0.5, 0.75)
    const promoted = await promoteLearning(root, accepted.id, { report: improved })
    assert.equal(promoted.status, "promoted")
    assert.equal(promoted.shadowValidation.delta, 0.25)
    assert.equal(promoted.shadowValidation.samples, 24)
    assert.equal(promoted.shadowValidation.model, "test/provider-model")
    assert.equal(promoted.shadowValidation.reportHash.length, 64)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
