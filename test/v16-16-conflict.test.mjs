// V16.16 Conflict Evidence: structured wiring + no false-positive text conflicts.
//
// Proves that production conflict decisions use STRONG structured evidence
// (declared services, external effects, generated outputs, planned commands,
// module edges) while natural-language task text is only a WEAK signal:
// source-code words like "service" and "tag" never create runtime conflicts,
// but actual destructive/external commands still fail closed.

import test from "node:test"
import assert from "node:assert/strict"

import {
  CONFLICT_KIND,
  PAIR_VERDICT,
  SCOPE_CERTAINTY,
  buildConflictGraph,
  classifyPair,
  normalizeScope,
} from "../lib/execution-conflict-graph-v16-15.mjs"

const writer = (id, files, extra = {}) => ({ id, readOnly: false, writeFiles: files, ...extra })

test("V16.16 conflict: same exact written file conflicts", () => {
  const pair = classifyPair(writer("a", ["lib/shared.mjs"]), writer("b", ["lib/shared.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.WRITE_WRITE_SAME_FILE))
})

test("V16.16 conflict: read/write on the same file conflicts", () => {
  const pair = classifyPair(
    { id: "a", readOnly: true, readFiles: ["lib/data.mjs"] },
    writer("b", ["lib/data.mjs"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.READ_WRITE_DEPENDENCY))
})

test("V16.16 conflict: different files in the same directory may parallelize", () => {
  const pair = classifyPair(writer("a", ["lib/a.mjs"]), writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT)
  const graph = buildConflictGraph([writer("a", ["lib/a.mjs"]), writer("b", ["lib/b.mjs"])], { maxParallel: 2 })
  assert.equal(graph.edgeCount, 0)
  assert.ok(graph.scopes.every((row) => row.certainty === SCOPE_CERTAINTY.INDEPENDENT))
})

test("V16.16 conflict: package.json vs package-lock still conflicts", () => {
  const pair = classifyPair(writer("a", ["package.json"]), writer("b", ["package-lock.json"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) =>
    row.kind === CONFLICT_KIND.SHARED_CONFIG_FAMILY || row.kind === CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION))
})

test("V16.16 conflict: 'service' in source-code prose is not a runtime service conflict", () => {
  for (const [left, right] of [
    ["update service class", "refactor service layer"],
    ["fix UserService validation", "UserService error handling"],
    ["extract the service helper", "rename service util"],
  ]) {
    const pair = classifyPair(
      writer("a", ["lib/a.mjs"], { task: left }),
      writer("b", ["lib/b.mjs"], { task: right }),
    )
    assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT, `${left} / ${right} misclassified`)
  }
})

test("V16.16 conflict: 'tag'/'release' in prose are not external side effects", () => {
  for (const [left, right] of [
    ["fix HTML tag rendering", "tag parser bug"],
    ["release lock in mutex", "release the mutex after use"],
    ["tag list component", "render tag cloud"],
  ]) {
    const pair = classifyPair(
      writer("a", ["lib/a.mjs"], { task: left }),
      writer("b", ["lib/b.mjs"], { task: right }),
    )
    assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT, `${left} / ${right} misclassified`)
  }
})

test("V16.16 conflict: declared mutable services still conflict strongly", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { services: ["dev-server"] }),
    writer("b", ["lib/b.mjs"], { services: ["dev-server"] }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SHARED_MUTABLE_SERVICE))
})

test("V16.16 conflict: declared external effects still conflict strongly", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { externalEffects: ["npm-publish"] }),
    writer("b", ["lib/b.mjs"], { externalEffects: ["npm-publish"] }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SAME_EXTERNAL_SIDE_EFFECT))
})

test("V16.16 conflict: actual planned publish commands conflict on both sides", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { commands: ["npm publish --access public"] }),
    writer("b", ["lib/b.mjs"], { commands: ["npm publish --access public"] }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SAME_EXTERNAL_SIDE_EFFECT))
  // ...and the declared commands are fingerprinted into the graph identity.
  const graph = buildConflictGraph([
    writer("a", ["lib/a.mjs"], { commands: ["npm publish"] }),
    writer("b", ["lib/b.mjs"]),
  ], { maxParallel: 2 })
  assert.ok(graph.fingerprint.startsWith("conflict-graph:sha256:"))
  // One-sided external command against an unrelated command stays
  // independent: an external effect collides only with the SAME effect.
  const single = classifyPair(
    writer("a", ["lib/a.mjs"], { commands: ["npm publish --access public"] }),
    writer("b", ["lib/b.mjs"], { commands: ["npm run build"] }),
  )
  assert.equal(single.verdict, PAIR_VERDICT.INDEPENDENT)
})

test("V16.16 conflict: actual destructive commands stay blocked", () => {
  for (const command of ["rm -rf dist", "git reset --hard HEAD", "npm publish"]) {
    const pair = classifyPair(
      writer("a", ["lib/a.mjs"], { task: command, commands: [command] }),
      writer("b", ["lib/b.mjs"], { task: `routine work near ${command}` }),
    )
    assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT, `${command} must fail closed`)
  }
})

test("V16.16 conflict: unambiguous external phrasing in prose still counts", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { task: "prepare npm publish of the package" }),
    writer("b", ["lib/b.mjs"], { task: "verify npm publish readiness" }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
})

test("V16.16 conflict: structured evidence is visible on the normalized scope", () => {
  const scope = normalizeScope({
    id: "a",
    writeFiles: ["lib/a.mjs"],
    services: ["dev-server"],
    externalEffects: ["deploy-prod"],
    generatedOutputs: ["lib/generated.mjs"],
    commands: ["npm run build"],
  })
  assert.deepEqual(scope.services, ["dev-server"])
  assert.deepEqual(scope.externalEffects, ["deploy-prod"])
  assert.deepEqual(scope.commands, ["npm run build"])
  assert.equal(scope.mutableServiceDeclared, true)
  assert.equal(scope.externalSideEffectDeclared, true)
})

test("V16.16 conflict: unknown writer scope still fails closed", () => {
  const pair = classifyPair(writer("a", []), writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.UNKNOWN_SCOPE))
})
