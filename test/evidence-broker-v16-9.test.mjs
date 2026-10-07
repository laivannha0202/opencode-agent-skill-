// V16.9 module tests: evidence-broker + shared-context-ledger.

import test from "node:test"
import assert from "node:assert/strict"
import {
  EVIDENCE_BROKER_POLICY,
  createEvidenceBroker,
} from "../lib/evidence-broker.mjs"
import {
  SHARED_CONTEXT_LEDGER_POLICY,
  createSharedContextLedger,
} from "../lib/shared-context-ledger.mjs"

function request(requests) {
  return JSON.stringify({ evidenceRequests: requests })
}

test("evidence-broker: serves an allowlisted request and reports unavailable kinds", () => {
  const broker = createEvidenceBroker({
    runId: "t1",
    root: process.cwd(),
    sources: { diff: () => "diff-content", "repo-summary": () => "summary" },
  })
  const out = broker.serve(request([{ kind: "diff" }, { kind: "file-excerpt" }]), {})
  assert.equal(out.requests, 2)
  assert.equal(out.authorized, 1)
  assert.equal(out.deltasSent, 1)
  assert.deepEqual(out.receipt.unavailableKinds, ["file-excerpt"])
  assert.ok(out.deltaText.includes("diff-content"))
  assert.equal(broker.policy, EVIDENCE_BROKER_POLICY)
})

test("evidence-broker: denied request is reported, never narrowed", () => {
  const broker = createEvidenceBroker({ runId: "t2", root: process.cwd(), sources: { diff: () => "x" } })
  // A non-allowlisted kind must be denied by the shared authority path. It is
  // rejected at PARSE (the parser owns the allowlist), and the receipt must
  // report that rejection rather than silently narrowing the request.
  const out = broker.serve(request([{ kind: "secret-file" }]), {})
  assert.equal(out.deltasSent, 0)
  assert.equal(out.receipt.requestsRejectedByParse, 1)
  assert.equal(out.receipt.denied, 0)
})

test("evidence-broker: workspace-escaping target is denied, never served", () => {
  const broker = createEvidenceBroker({
    runId: "t2b",
    root: process.cwd(),
    sources: { "file-excerpt": () => "should-not-be-served" },
  })
  const out = broker.serve(request([{ kind: "file-excerpt", target: "../../etc/passwd" }]), {})
  // Traversal is rejected by the shared parser (the first authority line), so
  // the broker reports a parse rejection and sends NOTHING. The source is never
  // invoked for a rejected request.
  assert.equal(out.deltasSent, 0)
  assert.equal(out.deltaText, "")
  assert.ok(out.receipt.requestsRejectedByParse >= 1)
})

test("evidence-broker: empty advisor text yields no deltas", () => {
  const broker = createEvidenceBroker({ runId: "t3", sources: {} })
  const out = broker.serve("", {})
  assert.equal(out.requests, 0)
  assert.equal(out.deltaText, "")
})

test("evidence-broker: source that throws does not crash the loop", () => {
  const broker = createEvidenceBroker({
    runId: "t4",
    root: process.cwd(),
    sources: { diff: () => { throw new Error("boom") } },
  })
  const out = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(out.deltasSent, 0)
  assert.ok(out.receipt.unavailableKinds.includes("diff"))
})

test("evidence-broker: a legitimately redacted delta is SERVED, not dropped", () => {
  // REGRESSION (found in V16.9 development): the defense-in-depth scan used
  // `redactSecrets(delta.text).redacted`, which reports `redacted: true` again
  // when it re-scans its own mask. That falsely DROPPED every delta whose
  // secret had already been masked by the budget - i.e. all the interesting
  // ones. The predicate must be `containsUnmaskedSecret`.
  const broker = createEvidenceBroker({
    runId: "t5",
    root: process.cwd(),
    sources: { diff: () => "api_key=sk-abcdef1234567890abcdef\nexport const value = 1" },
  })
  const out = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(out.deltasSent, 1, "an already-redacted delta must still be served")
  assert.ok(out.deltaText.includes("export const value = 1"), "the non-secret content must survive")
  assert.ok(!out.deltaText.includes("sk-abcdef1234567890abcdef"), "the secret must not survive")
})

test("shared-context-ledger: unchanged blocks are skipped and measured", () => {
  const ledger = createSharedContextLedger({ scope: "t1" })
  ledger.reset()
  const blocks = [{ key: "diff", text: "unchanged-diff-body" }]
  const first = ledger.planShare(blocks)
  assert.equal(first.toSend.length, 1)
  assert.equal(first.skipped.length, 0)
  const second = ledger.planShare(blocks)
  assert.equal(second.toSend.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.ok(second.savedChars > 0)
  assert.equal(second.savedTokens, null)
  assert.equal(second.savedTokensProvenance, "NOT_MEASURED")
  ledger.reset()
})

test("shared-context-ledger: changed block is re-sent with a delta", () => {
  const ledger = createSharedContextLedger({ scope: "t2" })
  ledger.reset()
  ledger.planShare([{ key: "plan", text: "line one\n" }])
  const changed = ledger.planShare([{ key: "plan", text: "line one\nline two\n" }])
  assert.equal(changed.toSend.length, 1)
  assert.equal(changed.toSend[0].state, "CHANGED")
  ledger.reset()
})

test("shared-context-ledger: policy constant is stable", () => {
  assert.equal(SHARED_CONTEXT_LEDGER_POLICY, "shared-context-ledger-v16-9")
})

// ---------------------------------------------------------------------------
// V16.9 ledger-in-broker parity: the ledger is the broker's internal dedup
// primitive. The FIRST delivery must be byte-identical to the no-ledger broker
// (parity), and a repeated/unchanged request must shrink to an evidence_id
// marker WITHOUT changing what the broker authorizes (no new owner).
// ---------------------------------------------------------------------------

test("evidence-broker + ledger: first delivery is byte-identical to the no-ledger broker", () => {
  const sources = { diff: () => "alpha\nbeta\ngamma" }
  const plain = createEvidenceBroker({ runId: "p", root: process.cwd(), sources })
  const ledger = createSharedContextLedger({ scope: "parity-1" })
  ledger.reset()
  const wired = createEvidenceBroker({ runId: "p", root: process.cwd(), sources, ledger })
  const a = plain.serve(request([{ kind: "diff" }]), {})
  const b = wired.serve(request([{ kind: "diff" }]), {})
  assert.equal(a.deltaText, b.deltaText, "first delivery must be byte-identical")
  assert.equal(b.receipt.evidenceResent, 1)
  assert.equal(b.receipt.evidenceReused, 0)
  ledger.reset()
})

test("evidence-broker + ledger: repeated UNCHANGED request reuses evidence_id and does not re-charge the budget", () => {
  const ledger = createSharedContextLedger({ scope: "parity-2" })
  ledger.reset()
  // Realistic evidence is large enough that a hash marker is genuinely
  // smaller. The honesty guard deliberately refuses to "save" on a tiny block
  // whose marker would be longer than the bytes.
  const body = Array.from({ length: 200 }, (_, i) => `export const row${i} = ${i}`).join("\n")
  const broker = createEvidenceBroker({
    runId: "p",
    root: process.cwd(),
    sources: { diff: () => body },
    ledger,
  })
  const first = broker.serve(request([{ kind: "diff" }]), {})
  const charsAfterFirst = broker.telemetry().budget.charsSent
  const second = broker.serve(request([{ kind: "diff" }]), {})
  const charsAfterSecond = broker.telemetry().budget.charsSent
  assert.equal(first.receipt.evidenceResent, 1)
  assert.equal(second.receipt.evidenceReused, 1)
  assert.equal(second.receipt.evidenceResent, 0)
  assert.ok(second.deltaText.includes("evidence_id="), "the marker must carry the evidence id")
  assert.ok(second.deltaText.length < first.deltaText.length, "the marker must be smaller than the bytes")
  assert.equal(charsAfterSecond, charsAfterFirst, "unchanged evidence must NOT be re-charged to the run budget")
  assert.equal(broker.telemetry().totalEvidenceReused, 1)
  assert.ok(broker.telemetry().totalReusedChars > 0)
  ledger.reset()
})

test("evidence-broker + ledger: a tiny unchanged block is NOT claimed as a saving (honesty guard)", () => {
  const ledger = createSharedContextLedger({ scope: "parity-2b" })
  ledger.reset()
  const broker = createEvidenceBroker({
    runId: "p",
    root: process.cwd(),
    sources: { diff: () => "x" },
    ledger,
  })
  broker.serve(request([{ kind: "diff" }]), {})
  const second = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(second.receipt.evidenceReused, 0, "a marker longer than the bytes must not be reported as reuse")
  ledger.reset()
})

test("evidence-broker + ledger: CHANGED evidence sends a bounded line delta, not the whole block", () => {
  const ledger = createSharedContextLedger({ scope: "parity-3" })
  ledger.reset()
  const base = Array.from({ length: 200 }, (_, i) => `line-${i}`)
  let body = base.join("\n")
  const broker = createEvidenceBroker({
    runId: "p",
    root: process.cwd(),
    sources: { diff: () => body },
    ledger,
  })
  broker.serve(request([{ kind: "diff" }]), {})
  body = [...base, "line-200"].join("\n")
  const changed = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(changed.receipt.evidenceDelta, 1)
  assert.equal(changed.receipt.evidenceResent, 0)
  assert.ok(changed.deltaText.includes("delta"), "a changed block must be delivered as a delta")
  assert.ok(changed.deltaText.length < body.length, "the delta must be smaller than the whole block")
  ledger.reset()
})

test("evidence-broker + ledger: separate scopes never leak reuse across workspaces", () => {
  const a = createSharedContextLedger({ scope: "ws-a" })
  const b = createSharedContextLedger({ scope: "ws-b" })
  a.reset()
  b.reset()
  const sources = { diff: () => "same-bytes" }
  const brokerA = createEvidenceBroker({ runId: "a", root: process.cwd(), sources, ledger: a })
  const brokerB = createEvidenceBroker({ runId: "b", root: process.cwd(), sources, ledger: b })
  brokerA.serve(request([{ kind: "diff" }]), {})
  const firstB = brokerB.serve(request([{ kind: "diff" }]), {})
  assert.equal(firstB.receipt.evidenceResent, 1, "a different scope must send the full bytes")
  assert.equal(firstB.receipt.evidenceReused, 0)
  a.reset()
  b.reset()
})

test("evidence-broker + ledger: ledger.reset() clears reuse so evidence is re-sent", () => {
  const ledger = createSharedContextLedger({ scope: "parity-5" })
  ledger.reset()
  const broker = createEvidenceBroker({
    runId: "p",
    root: process.cwd(),
    sources: { diff: () => "bytes" },
    ledger,
  })
  broker.serve(request([{ kind: "diff" }]), {})
  broker.serve(request([{ kind: "diff" }]), {})
  broker.reset()
  const after = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(after.receipt.evidenceResent, 1, "after reset the bytes must be sent again")
  ledger.reset()
})

test("shared-context-ledger: bumpEpoch invalidates reuse (source mutation)", () => {
  const ledger = createSharedContextLedger({ scope: "epoch-1" })
  ledger.reset()
  const body = Array.from({ length: 200 }, (_, i) => `row-${i}`).join("\n")
  const first = ledger.planShare([{ key: "diff:", text: body }])
  assert.equal(first.toSend.length, 1)
  const second = ledger.planShare([{ key: "diff:", text: body }])
  assert.equal(second.toSend.length, 0, "unchanged within the same epoch is skipped")
  ledger.bumpEpoch("post-write")
  assert.equal(ledger.state().epoch, 1)
  const afterMutation = ledger.planShare([{ key: "diff:", text: body }])
  assert.equal(afterMutation.toSend.length, 1, "after a mutation the same bytes are NEW again")
  ledger.reset()
})

test("evidence-broker + ledger: a workspace mutation forces a full re-send, never stale reuse", () => {
  const ledger = createSharedContextLedger({ scope: "epoch-2" })
  ledger.reset()
  const body = Array.from({ length: 200 }, (_, i) => `row-${i}`).join("\n")
  const broker = createEvidenceBroker({
    runId: "p",
    root: process.cwd(),
    sources: { diff: () => body },
    ledger,
  })
  broker.serve(request([{ kind: "diff" }]), {})
  const reused = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(reused.receipt.evidenceReused, 1)
  ledger.bumpEpoch("post-write")
  const resent = broker.serve(request([{ kind: "diff" }]), {})
  assert.equal(resent.receipt.evidenceResent, 1, "after a write the evidence must be re-sent in full")
  assert.equal(resent.receipt.evidenceReused, 0)
  ledger.reset()
})
