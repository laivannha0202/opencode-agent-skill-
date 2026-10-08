// V16.15 Execution Conflict Graph V2.
//
// Proves the V16.15 conflict rules replaced V16.5's coarse "same two-segment
// root ⇒ conflict" heuristic with an EXACT relation model, and that the model
// fails closed on anything it cannot prove:
//   * same exact file            -> conflict
//   * read/write dependency      -> conflict (both directions)
//   * different files, same dir  -> INDEPENDENT (the V16.5 over-serialization)
//   * different packages         -> INDEPENDENT
//   * shared config family       -> conflict
//   * lockfile vs manifest       -> conflict
//   * generated-output edge      -> conflict
//   * declared module edge       -> conflict
//   * unknown / unnormalizable   -> conflict (fail closed)

import test from "node:test"
import assert from "node:assert/strict"

import {
  CONFLICT_KIND,
  PAIR_VERDICT,
  SCOPE_CERTAINTY,
  buildConflictGraph,
  classifyPair,
  isWriterScope,
  normalizeConflictPath,
  normalizeScope,
  scopesAreIndependent,
} from "../lib/execution-conflict-graph-v16-15.mjs"

const writer = (id, writeFiles, extra = {}) => ({ id, readOnly: false, writeFiles, ...extra })

test("V16.15 conflict: two writers on the same exact file conflict", () => {
  const pair = classifyPair(writer("a", ["lib/shared.mjs"]), writer("b", ["lib/shared.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.WRITE_WRITE_SAME_FILE))
})

test("V16.15 conflict: a read/write dependency conflicts in BOTH directions", () => {
  const forward = classifyPair(
    writer("a", ["lib/api.mjs"]),
    { id: "b", readOnly: false, writeFiles: ["lib/other.mjs"], readFiles: ["lib/api.mjs"] },
  )
  assert.equal(forward.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(forward.relations.some((row) => row.kind === CONFLICT_KIND.READ_WRITE_DEPENDENCY))

  const backward = classifyPair(
    { id: "b", readOnly: false, writeFiles: ["lib/other.mjs"], readFiles: ["lib/api.mjs"] },
    writer("a", ["lib/api.mjs"]),
  )
  assert.equal(backward.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(backward.relations.some((row) => row.kind === CONFLICT_KIND.READ_WRITE_DEPENDENCY))
})

test("V16.15 conflict: two different files in the SAME directory are INDEPENDENT", () => {
  // This is the exact V16.5 over-serialization V16.15 removes: both scopes reduce
  // to the two-segment root "lib/x", which the old classifier treated as a
  // conflict even though the writers cannot corrupt each other.
  const left = writer("a", ["lib/x/one.mjs"])
  const right = writer("b", ["lib/x/two.mjs"])
  const pair = classifyPair(left, right)
  assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT)
  assert.deepEqual(pair.relations, [])

  const graph = buildConflictGraph([left, right], { maxParallel: 2 })
  assert.equal(graph.edgeCount, 0)
  assert.equal(graph.parallelWaves, 1)
  assert.deepEqual(graph.waves, [["a", "b"]])
})

test("V16.15 conflict: writers in different isolated packages are INDEPENDENT", () => {
  const graph = buildConflictGraph([
    writer("a", ["packages/alpha/src/index.ts"]),
    writer("b", ["packages/beta/src/index.ts"]),
  ], { maxParallel: 2 })
  assert.equal(graph.edgeCount, 0)
  assert.equal(graph.scopes.every((row) => row.certainty === SCOPE_CERTAINTY.INDEPENDENT), true)
})

test("V16.15 conflict: a shared config family conflicts even on different paths", () => {
  const pair = classifyPair(
    writer("a", ["package.json"]),
    writer("b", ["package-lock.json"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  const kinds = pair.relations.map((row) => row.kind)
  assert.ok(kinds.includes(CONFLICT_KIND.SHARED_CONFIG_FAMILY) || kinds.includes(CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION))
})

test("V16.15 conflict: a lockfile refresh conflicts with a concurrent manifest write", () => {
  const pair = classifyPair(
    writer("a", ["packages/alpha/package.json"]),
    writer("b", ["package-lock.json"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION))
})

test("V16.15 conflict: two manifests conflict through the shared dependency family", () => {
  const pair = classifyPair(
    writer("a", ["packages/alpha/package.json"]),
    writer("b", ["packages/beta/package.json"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SHARED_CONFIG_FAMILY))
})

test("V16.15 conflict: a root tsconfig edit conflicts with another root tsconfig edit", () => {
  const pair = classifyPair(writer("a", ["tsconfig.json"]), writer("b", ["tsconfig.build.json"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SHARED_CONFIG_FAMILY))
})

test("V16.15 conflict: a generated-output edge conflicts", () => {
  const pair = classifyPair(
    writer("a", ["lib/schema.ts"], { generatedOutputs: ["lib/generated/schema.gen.ts"] }),
    writer("b", ["lib/generated/schema.gen.ts"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.GENERATED_OUTPUT))
})

test("V16.15 conflict: a declared module edge between two written modules conflicts", () => {
  const pair = classifyPair(
    writer("a", ["lib/alpha.mjs"]),
    writer("b", ["lib/beta.mjs"]),
    { moduleEdges: [{ from: "lib/alpha.mjs", to: "lib/beta.mjs" }] },
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.MODULE_DEPENDENCY))
})

test("V16.15 conflict: no declared module edges means no invented module edge", () => {
  const pair = classifyPair(writer("a", ["lib/alpha.mjs"]), writer("b", ["lib/beta.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT)
})

test("V16.15 conflict: a shared mutable service conflicts", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { services: ["dev-server"] }),
    writer("b", ["lib/b.mjs"], { services: ["dev-server"] }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SHARED_MUTABLE_SERVICE))
})

test("V16.15 conflict: the same external side effect conflicts", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { externalEffects: ["npm-publish"] }),
    writer("b", ["lib/b.mjs"], { externalEffects: ["npm-publish"] }),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.SAME_EXTERNAL_SIDE_EFFECT))
})

test("V16.15 conflict: a destructive shell command conflicts with everything", () => {
  const pair = classifyPair(
    writer("a", ["lib/a.mjs"], { task: "rm -rf node_modules" }),
    writer("b", ["lib/b.mjs"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.DESTRUCTIVE_SHELL))
})

test("V16.15 conflict: an unknown write scope fails conservative", () => {
  const pair = classifyPair(writer("a", []), writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.UNKNOWN_SCOPE))

  const graph = buildConflictGraph([writer("a", []), writer("b", ["lib/b.mjs"])], { maxParallel: 2 })
  assert.equal(graph.hasUnknown, true)
  assert.deepEqual(graph.unknownScopes, ["a"])
  assert.equal(graph.parallelWaves, 0)
})

test("V16.15 conflict: two unknown scopes conflict with each other", () => {
  const pair = classifyPair(writer("a", []), writer("b", []))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
})

test("V16.15 conflict: an unnormalizable path fails conservative", () => {
  const pair = classifyPair(writer("a", ["../../etc/passwd"]), writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.UNKNOWN_SCOPE))
})

test("V16.15 conflict: an absolute path fails conservative", () => {
  for (const hostile of ["/etc/passwd", "C:/Windows/system32/drivers/etc/hosts", "\\\\server\\share\\file"]) {
    assert.equal(normalizeConflictPath(hostile), "", `expected ${hostile} to be rejected`)
    const pair = classifyPair(writer("a", [hostile]), writer("b", ["lib/b.mjs"]))
    assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  }
})

test("V16.15 conflict: a parent-escape path fails conservative", () => {
  assert.equal(normalizeConflictPath("../outside.mjs"), "")
  assert.equal(normalizeConflictPath("lib/../../outside.mjs"), "")
})

test("V16.15 conflict: path normalization is deterministic and OS-agnostic", () => {
  assert.equal(normalizeConflictPath("lib\\a\\b.mjs"), "lib/a/b.mjs")
  assert.equal(normalizeConflictPath("./lib/a.mjs"), "lib/a.mjs")
  assert.equal(normalizeConflictPath("lib/./a.mjs"), "lib/a.mjs")
  assert.equal(normalizeConflictPath("lib/x/../a.mjs"), "lib/a.mjs")
})

test("V16.15 conflict: the same scope id is always a conflict", () => {
  const pair = classifyPair(writer("a", ["lib/a.mjs"]), writer("a", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
})

test("V16.15 graph: waves never place two conflicting scopes together", () => {
  const graph = buildConflictGraph([
    writer("a", ["lib/shared.mjs"]),
    writer("b", ["lib/shared.mjs"]),
    writer("c", ["pkg/other/index.ts"]),
  ], { maxParallel: 3 })
  assert.ok(graph.edgeCount >= 1)
  for (const wave of graph.waves) {
    for (let i = 0; i < wave.length; i += 1) {
      for (let j = i + 1; j < wave.length; j += 1) {
        const conflict = graph.edges.some((edge) =>
          (edge.left === wave[i] && edge.right === wave[j]) || (edge.left === wave[j] && edge.right === wave[i]))
        assert.equal(conflict, false, `${wave[i]} and ${wave[j]} must not share a wave`)
      }
    }
  }
})

test("V16.15 graph: wave count respects maxParallel", () => {
  const scopes = Array.from({ length: 5 }, (_, index) => writer(`t${index + 1}`, [`pkg${index + 1}/src/index.ts`]))
  const graph = buildConflictGraph(scopes, { maxParallel: 2 })
  for (const wave of graph.waves) assert.ok(wave.length <= 2)
  assert.equal(graph.waves.flat().length, 5)
})

test("V16.15 graph: identical input yields an identical fingerprint", () => {
  const scopes = [writer("a", ["pkg1/src/index.ts"]), writer("b", ["pkg2/src/index.ts"])]
  const first = buildConflictGraph(scopes, { maxParallel: 2 })
  const second = buildConflictGraph(scopes, { maxParallel: 2 })
  assert.equal(first.fingerprint, second.fingerprint)
  assert.deepEqual(first.waves, second.waves)
})

test("V16.15 graph: a different input yields a different fingerprint", () => {
  const first = buildConflictGraph([writer("a", ["pkg1/src/index.ts"])], { maxParallel: 2 })
  const second = buildConflictGraph([writer("a", ["pkg2/src/index.ts"])], { maxParallel: 2 })
  assert.notEqual(first.fingerprint, second.fingerprint)
})

test("V16.15 graph: duplicate scope ids are refused, never silently merged", () => {
  assert.throws(
    () => buildConflictGraph([writer("dup", ["a.ts"]), writer("dup", ["b.ts"])]),
    /duplicate scope id/,
  )
})

test("V16.15 graph: scope classification reports explicit reasons, never intuition", () => {
  const graph = buildConflictGraph([
    writer("a", ["lib/shared.mjs"]),
    writer("b", ["lib/shared.mjs"]),
  ], { maxParallel: 2 })
  for (const edge of graph.edges) {
    assert.ok(edge.kinds.length > 0)
    assert.ok(edge.relations.length > 0)
    for (const relation of edge.relations) assert.ok(relation.kind)
  }
  assert.equal(graph.deterministic, true)
})

test("V16.15 graph: an independent pair reports no relation, and a conflict always reports one", () => {
  const independent = scopesAreIndependent(writer("a", ["pkg1/a.ts"]), writer("b", ["pkg2/b.ts"]))
  assert.equal(independent.independent, true)
  assert.deepEqual(independent.kinds, [])

  const conflicting = scopesAreIndependent(writer("a", ["same.ts"]), writer("b", ["same.ts"]))
  assert.equal(conflicting.independent, false)
  assert.ok(conflicting.kinds.length > 0)
})

test("V16.15 graph: read-only scopes never conflict with each other on shared reads", () => {
  const pair = classifyPair(
    { id: "a", readOnly: true, writeFiles: [], readFiles: ["lib/a.mjs"] },
    { id: "b", readOnly: true, writeFiles: [], readFiles: ["lib/a.mjs"] },
  )
  assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT)
})

test("V16.15 graph: a read-only scope reading what a writer rewrites conflicts", () => {
  const pair = classifyPair(
    { id: "reader", readOnly: true, writeFiles: [], readFiles: ["lib/api.mjs"] },
    writer("writer", ["lib/api.mjs"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.READ_WRITE_DEPENDENCY))
})

test("V16.15 graph: normalizeScope keeps declared paths and drops nothing silently", () => {
  const scope = normalizeScope({ id: "x", writeFiles: ["lib/a.mjs", "lib/a.mjs", ""] })
  assert.deepEqual(scope.writeFiles, ["lib/a.mjs"])
  assert.equal(scope.scopeUnknown, false)

  const hostile = normalizeScope({ id: "y", writeFiles: ["/etc/passwd"] })
  assert.equal(hostile.scopeUnknown, true)
  assert.deepEqual(hostile.unnormalizablePaths, ["/etc/passwd"])
})

// ---------------------------------------------------------------------------
// the ONE writer rule
//
// Regression: the execution policy used to decide "is this a writer?" with
// `readOnly !== true` while the graph decided it with "declared a write path".
// A scope that declared NOTHING was a writer to the policy and a harmless
// READER to the graph, so a silent scope could be scheduled next to a real
// writer. Both now call `isWriterScope`.
// ---------------------------------------------------------------------------

test("V16.15 writers: a scope that declared nothing is a WRITER with an unknown scope", () => {
  assert.equal(isWriterScope({ id: "silent" }), true)
  const scope = normalizeScope({ id: "silent" })
  assert.equal(scope.writer, true)
  assert.equal(scope.readOnly, false)
  assert.equal(scope.scopeUnknown, true)

  // And it conflicts with a real writer instead of being waved through.
  const pair = classifyPair({ id: "silent" }, writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
  assert.ok(pair.relations.some((row) => row.kind === CONFLICT_KIND.UNKNOWN_SCOPE))
})

test("V16.15 writers: a scope that declared ONLY reads is a reader", () => {
  assert.equal(isWriterScope({ id: "reader", readFiles: ["lib/a.mjs"] }), false)
  const pair = classifyPair(
    { id: "reader", readFiles: ["lib/other.mjs"] },
    writer("b", ["lib/b.mjs"]),
  )
  assert.equal(pair.verdict, PAIR_VERDICT.INDEPENDENT)
})

test("V16.15 writers: the writer rule is explicit and both directions agree", () => {
  // Explicit declarations always win, in both directions.
  assert.equal(isWriterScope({ id: "x", readOnly: true, writeFiles: ["lib/a.mjs"] }), false)
  assert.equal(isWriterScope({ id: "x", writer: false, files: ["lib/a.mjs"] }), false)
  assert.equal(isWriterScope({ id: "x", readOnly: false }), true)
  assert.equal(isWriterScope({ id: "x", writer: true }), true)
  // A declaration of write paths makes a writer even without an explicit flag.
  assert.equal(isWriterScope({ id: "x", files: ["lib/a.mjs"] }), true)
  assert.equal(isWriterScope({ id: "x", write: ["lib/a.mjs"] }), true)
  // Blank entries are not a declaration.
  assert.equal(isWriterScope({ id: "x", writeFiles: ["  ", ""] }), true)
})

test("V16.15 writers: a hostile-only declaration is still a writer and fails closed", () => {
  const scope = normalizeScope({ id: "x", writeFiles: ["../../etc/passwd"] })
  assert.equal(scope.writer, true)
  assert.equal(scope.scopeUnknown, true)
  const pair = classifyPair({ id: "x", writeFiles: ["../../etc/passwd"] }, writer("b", ["lib/b.mjs"]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
})

test("V16.15 writers: declared module edges are visible to the graph the policy uses", () => {
  // A caller-declared edge between two written files must reach the graph, or a
  // real dependency becomes invisible and two dependent writers run together.
  const scopes = [writer("a", ["lib/a.mjs"]), writer("b", ["lib/b.mjs"])]
  const withoutEdges = buildConflictGraph(scopes, { maxParallel: 2 })
  assert.equal(withoutEdges.edgeCount, 0)

  const withEdges = buildConflictGraph(scopes, {
    maxParallel: 2,
    moduleEdges: [{ from: "lib/a.mjs", to: "lib/b.mjs" }],
  })
  assert.equal(withEdges.edgeCount, 1)
  assert.ok(withEdges.conflictKinds.includes(CONFLICT_KIND.MODULE_DEPENDENCY))
  assert.equal(withEdges.parallelWaves, 0)
})
