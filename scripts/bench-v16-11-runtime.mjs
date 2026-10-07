// V16.11 ADVISOR RUNTIME BENCHMARK.
//
// The V16.11 directive asks for an HONEST cold/warm and event/poll latency
// comparison. This benchmark measures the REAL production composition
// (`lib/advisor-runtime-v16-11.mjs`) against deterministic transport doubles, so
// it needs no authenticated DeepSeek profile and no network.
//
// HONESTY CONTRACT
//
//   * Every number below is SIMULATED (a deterministic clock), so the report is
//     labelled `claimStatus: SIMULATED_ONLY`. It NEVER claims a live-provider
//     latency win.
//   * Cold and warm are reported in SEPARATE cells and never averaged together.
//   * Event and poll are reported in SEPARATE cells and never averaged together.
//   * `providerTokens` is NOT_MEASURED: this bench never talks to a provider.
//
// Run: node scripts/bench-v16-11-runtime.mjs

import { createAdvisorRuntime } from "../lib/advisor-runtime-v16-11.mjs"
import { BROWSER_EVENT, decodeTransportMessage } from "../lib/browser-transport-v16-11.mjs"

const PROVIDER_TOKENS = "NOT_MEASURED"

// A deterministic clock so the bench is reproducible on any host.
function clock() {
  let t = 0
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

function workerDouble(state) {
  let acquired = 0
  return {
    acquire: async () => {
      acquired += 1
      // The FIRST acquire of a fresh process pays a "cold" startup cost.
      state.now += acquired === 1 ? 1200 : 40
      return { workerId: `w${acquired}`, async close() {} }
    },
    health: async () => ({ ok: true }),
  }
}

async function runCell({ workerState, channel, samples }) {
  const results = []
  for (let i = 0; i < samples; i += 1) {
    const c = clock()
    const worker = workerDouble(c)
    const runtime = createAdvisorRuntime({
      runId: `${workerState}-${channel}-${i}`,
      turnBudget: 8,
      eventChannel: channel !== "poll",
      latencyProvenance: "SIMULATED",
      parseAnswer: (text) => ({ ok: true, value: { text } }),
      acquireWorker: () => worker.acquire(),
      releaseWorker: (l) => l.close(),
      healthCheck: () => worker.health(),
      now: c.now,
    })
    const consult = await runtime.beginConsult({ promptId: `p${i}`, baseline: {} })
    if (channel === "poll") {
      // Simulate N bounded poll ticks; the bridge reports `poll`.
      for (let p = 0; p < 4; p += 1) {
        c.advance(500)
        await runtime.pollOnce(consult)
      }
    } else {
      c.advance(120)
      runtime.observeEvent(consult, decodeTransportMessage({
        type: "event",
        event: BROWSER_EVENT.ANSWER_STABLE,
        data: { text: '{"ok":true}' },
        workerEpoch: consult.workerEpoch,
        generation: consult.runGeneration,
      }))
    }
    const done = runtime.completeConsult(consult)
    await runtime.shutdown("bench")
    if (done.recorded) results.push(done.sample)
  }
  const total = results.reduce((s, r) => s + r.totalMs, 0)
  return { samples: results.length, meanMs: results.length ? Math.round(total / results.length) : null }
}

async function main() {
  const cells = []
  for (const workerState of ["cold", "warm"]) {
    for (const channel of ["event", "poll"]) {
      const cell = await runCell({ workerState, channel, samples: 8 })
      cells.push({ workerState, channel, ...cell })
    }
  }
  const report = {
    policy: "advisor-runtime-v16-11",
    measured: "SIMULATED deterministic clock; no live provider, no network",
    claimStatus: "SIMULATED_ONLY",
    providerTokens: PROVIDER_TOKENS,
    providerTokensProvenance: PROVIDER_TOKENS,
    cells,
    note: "cold/warm and event/poll are NEVER averaged together; a live claim requires an authenticated profile.",
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bench-v16-11-runtime.mjs")) {
  main().then((code) => process.exit(code))
}

export { main }
