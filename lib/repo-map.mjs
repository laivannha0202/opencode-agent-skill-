// Graph-ranked repository map (V15.3 Phase 3).
//
// The model needs a map, not a dump. Handing it a ranked file list is only
// useful if the ranking is right, and the ranking is where a weak model loses
// the most: it either reads too little and misses the edit site, or reads too
// much and runs out of context before it starts working.
//
// This module produces a small, focused map under an explicit character budget.
// It is a pipeline with fixed stages, and each stage is deterministic:
//
//   candidate generation -> feature scoring -> graph propagation -> budget
//
// Stage boundaries exist so no stage can quietly become the model's own
// judgement. Nothing here lets a caller "just rank it yourself": a caller
// supplies evidence (query text, declared files, changed files) and receives an
// ordered, budgeted map with a reason attached to every row.
//
// It deliberately reuses the primitives the runtime already has rather than
// adding a second index or a second graph:
//   - `buildSemanticIndexCached` for symbols and identifiers
//   - `querySemanticIndex`    for lexical/symbol candidates
//   - `buildRepoGraphCached`  for import edges
//   - `rankContextGraph`      for bounded personalized-PageRank propagation
//   - `resolveAffectedTests`  for test links
// Adding a different graph algorithm here is only justified by a measurement,
// and the retrieval benchmark (scripts/bench-repo-map.mjs) is that measurement.

import path from "node:path"
import { buildSemanticIndexCached, clearSemanticIndexRuntimeCache, querySemanticIndex } from "./semantic-index.mjs"
import { buildRepoGraphCached, clearRepoGraphRuntimeCache } from "./repo-graph.mjs"
import { rankContextGraph } from "./context-graph-rank.mjs"
import { gitChangedFiles, resolveAffectedTests } from "./affected-tests.mjs"
import { createModuleResolver, gradePathToken, identityTokens, isUsableRelativePath, normalizeRelativePath } from "./module-identity.mjs"

export const REPO_MAP_DEFAULTS = Object.freeze({
  maxCandidates: 240,
  maxFiles: 6000,
  limit: 12,
  contextBudgetChars: 6_000,
  // Graph propagation is bounded on every axis: a runaway graph must cost
  // time proportional to the candidate set, never to the repository.
  propagationDepth: 2,
  maxPropagationNodes: 240,
  // Relationship generation is bounded on three axes, all of them per query:
  // how many seeds are expanded, how many dependents one seed may contribute
  // (past that a file is a hub, not a subject), and how many second-hop rows
  // are admitted at all.
  maxRelationshipSeeds: 8,
  maxDependentsPerSeed: 12,
  maxSecondHop: 24,
  maxEnrichedFiles: 3,
  maxSymbolsPerFile: 6,
  testLinksPerFile: 3,
  // Relationship provenance is evidence the reader can audit, so it is bounded
  // like every other per-row list rather than truncated at emit time.
  maxRelationshipsPerRow: 6,
})

// Fixed feature weights. They are constants, not tunables: a ranking that a
// caller can re-weight per query stops being comparable between runs, and the
// retrieval gate in scripts/bench-repo-map.mjs would stop meaning anything.
export const REPO_MAP_WEIGHTS = Object.freeze({
  // A declaration (function/class/interface/type) whose name IS the query term
  // is the strongest evidence a lexical index can produce.
  exactSymbol: 100,
  // A local const/let carrying the term is scoped to one function. Giving it
  // declaration weight is what let an unrelated `const total` outrank the
  // module that defines the API, so it stays deliberately weak.
  localBinding: 6,
  symbolPrefix: 30,
  // A symbol that merely CONTAINS the term is a mention, not a definition:
  // `legacyPricingSheet` does not make pricing-legacy.mjs the pricing module.
  symbolMention: 10,
  // PATH evidence is graded by how much of the path the query actually named,
  // strongest first. This is a HIERARCHY, not a set of independent segment
  // tests: a token with two or more segments names ONE location, so
  // `modules/quay` can only be answered by a candidate under `modules/quay`.
  // Grading such a token segment-by-segment is what credited `modules/dockyard`
  // for a `modules/quay` query through the shared parent directory.
  pathExact: 85,
  pathPrefix: 38,
  pathModuleRoot: 26,
  pathBasename: 45,
  pathSegment: 16,
  pathPartial: 5,
  // A query term that names a DECLARED module boundary -- a package.json name, a
  // Go package clause, a workspace member, a Python package, a container child.
  //
  // Its only job is to break a tie between two files that declare the SAME
  // symbol in different modules. It is deliberately far below every declaration
  // signal, so it can never make a file that merely sits in the named module
  // outrank a file that DEFINES what the query asked about, and it is awarded
  // only from a declared boundary -- never from an arbitrary ancestor name.
  queryModuleMatch: 24,
  declared: 46,
  identifierReference: 5,
  // A DECLARATION whose words cover the query term, and how many distinct query
  // terms one declaration spans.
  //
  // This is the feature the old ranking did not have, and its absence is why a
  // file that merely CONTAINED the query word outranked the file that DEFINED
  // it: `warpThread` scored as a prefix hit for "warp", while the declaration
  // that actually answers "weaving a cloth" -- `weaveCloth`, whose words cover
  // both "weave" and "cloth" -- scored nothing at all.
  //
  // The ceiling is deliberately less than half of `exactSymbol`: a derived match
  // is lower-confidence evidence and may never overturn a declaration that owns
  // the identifier outright. `derivedDefinitionCeiling` is where the ladder
  // stops, and it is enforced in feature scoring rather than by convention.
  derivedDefinition: 34,
  derivedDefinitionCoverageStep: 6,
  derivedDefinitionCeiling: 52,
  // A unique declaration that spans the query's subject words. It is reported as
  // its own feature rather than folded into the derived grade so the map can say
  // WHY a file leads, and it stays below an exact identifier definition so a
  // derived reading of a query never outranks a declaration that owns the name.
  explicitPathTarget: 90,
  directImport: 26,
  reverseReference: 20,
  changedFile: 30,
  affectedTest: 24,
  // Applied ONLY to a test file that matched the query's own noun while the
  // query explicitly named a test. Bounded, and gated on a structural match, so
  // it cannot be earned by a test file that merely sits in the candidate set.
  testTarget: 70,
  // A test file never outranks the source file it covers. Expressed as an
  // ordering constraint rather than a score penalty, so it is not applied twice.
  testDemotion: 55,
  moduleSibling: 5,
  // A second-hop neighbour is context, never an answer: it is admitted so a
  // reader can see the shape of the area, and it is capped below the weakest
  // direct signal so it cannot reorder the head of the list.
  secondHop: 6,
  // The unique file whose dependency edges converge on two or more of the
  // query's own subjects. Real evidence, and bounded like everything else.
  convergentDependency: 12,
  hotspot: 3,
  propagated: 12,
  // Memory affinity is a tie-breaker by construction. It is capped below the
  // smallest direct-code signal so no remembered opinion can outrank a symbol
  // that actually exists in the file, or a file the task declared.
  memoryAffinity: 4,
})

export function normalizeMapPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim()
}

// A path only reaches the map if it is a workspace-relative source path.
// Declared files, changed files and test inventories all arrive from outside
// this module -- git, a plan, an LSP -- so they are filtered here rather than
// trusted. An absolute path, a drive letter, a `..` segment or a NUL is
// refused outright instead of being cleaned up, because "cleaning up" a
// traversal is how it becomes a read outside the workspace.
export function isWorkspaceRelativeMapPath(value) {
  const normalized = normalizeMapPath(value)
  if (!normalized) return false
  if (normalized.includes(" ")) return false
  if (normalized.startsWith("/")) return false
  if (normalized.startsWith("~")) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  if (normalized.startsWith("//")) return false
  return !normalized.split("/").some((segment) => segment === "..")
}

// TEST VOCABULARY -- one list, used for classification AND for intent.
//
// The pre-repair classifier was a single regex covering the JavaScript and
// TypeScript conventions and nothing else. Measured blind spots: Go's
// `smelt_test.go`, a `specs/` directory, Java's `ThingTest.java`, and a flat
// `test_thing.py` all came back false. A file the runtime does not know is a test
// gets no source pairing, no intent handling and no ordering constraint, which is
// a large part of why the test-lookup class regressed in every corpus: the rule
// that was supposed to protect it simply did not see it.
const TEST_DIR_SEGMENTS = new Set([
  "test", "tests", "spec", "specs", "__tests__", "__test__", "testing", "unittests", "integration",
])

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "where", "what",
  "when", "which", "does", "is", "are", "was", "were", "should", "would", "could",
  "after", "before", "while", "there", "their", "have", "will", "doesn", "don",
  "file", "files", "code", "task", "fix", "update", "change", "changes", "wrong",
])

export function queryTerms(query) {
  // Windows separators are normalised BEFORE tokenisation. `modules\quay` and
  // `modules/quay` name the same location, and splitting on the backslash turned
  // one path token into two bare words -- the first of which then matched the
  // shared parent directory of every module in the tree.
  return [...new Set(
    normalizeMapPath(query)
      .split(/[^\p{L}\p{N}_$./-]+/u)
      .map((item) => item.replace(/^[-.$/]+|[-.$/]+$/g, ""))
      .filter((item) => item.length >= 2 && !STOP.has(item.toLowerCase())),
  )].slice(0, 24)
}

// The same words `isTestFile` already uses to decide what a test file is. Intent
// detection reuses THIS vocabulary rather than a second hand-written list, so the
// two cannot drift apart: if the runtime learns a new test convention, both the
// classifier and the intent test move together.
const TEST_INTENT_PARTS = new Set([
  "test", "tests", "spec", "specs", "unittests", "unittest", "integration", "testing",
])

// A query names a test when one of its terms is built ONLY from those words.
// Requiring every part to be a test word keeps "testing" and "specimen" out, and
// it generalises to "unit test", "integration spec" and so on without a
// per-language list.
function hasExplicitTestIntent(lowerTerms) {
  return lowerTerms.some((term) => {
    const parts = identifierParts(term).map(singular)
    return parts.length > 0 && parts.every((part) => TEST_INTENT_PARTS.has(part))
  })
}

// A term built only from test vocabulary names the KIND of answer the query
// wants, not its subject. It is excluded from subject coverage for the same
// reason "the" is a stopword: `test_sign_payload_is_stable` covers the word
// "test", so treating "test" as a subject made EVERY test file a match for the
// subject of every test-shaped query, and three unrelated specs reached the top
// three of "test that applyTension scales".
function isTestVocabulary(term) {
  const parts = identifierParts(term).map(singular)
  return parts.length > 0 && parts.every((part) => TEST_INTENT_PARTS.has(part))
}

function isTestFile(file) {
  const normalized = normalizeMapPath(file)
  const parts = normalized.split("/")
  const base = parts[parts.length - 1] || ""
  if (parts.slice(0, -1).some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()))) return true
  // Dotted infix: foo.test.ts, foo.spec.jsx
  if (/\.(test|spec)s?\.[cm]?[jt]sx?$/i.test(base)) return true
  // Suffixed stem, the Go and Rust convention: foo_test.go, foo_spec.rs
  if (/[._-](test|spec)s?$/i.test(base.replace(/\.[^.]+$/, ""))) return true
  // Prefixed stem, the Python and Java convention: test_foo.py, FooTest.java
  const stem = base.replace(/\.[^.]+$/, "")
  if (/^(test|spec)[._-]/i.test(stem)) return true
  if (/^(Test|Spec)[A-Z]/.test(stem)) return true
  return false
}


// `orders` answers "order", and `pricing.test` answers "pricing". A trailing
// plural is the only inflection folded here: anything vaguer stops being
// evidence and starts being a guess.
function singular(stem) {
  const value = String(stem || "").toLowerCase()
  if (value.length >= 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1)
  return value
}

// WORD PARTS of an identifier.
//
// Used to decide what a test file is called and whether a query names a test,
// never to grade a path. Grading paths on sub-tokens was measured and rejected;
// see the note on `pathBasename`.
//
// It is a tokenizer, not a keyword list: camelCase, snake_case, kebab-case,
// ACRONYM and digit boundaries all split the same way, and it adds no
// query-specific knowledge.
export function identifierParts(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.\-\s]+/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const MIN_PART_MATCH = 3

// Files a module publishes itself under. Used to pick a module's entry point.
const DIRECTORY_ENTRY_STEMS = new Set(["index", "__init__", "mod", "main"])

// ---------------------------------------------------------------------------
// STEP A -- query term provenance
// ---------------------------------------------------------------------------
//
// Every ranking decision below is traced back to a term, so the term has to
// say what KIND of term it is. A bare string list cannot: "Seal" in "fix the
// Seal handler" and "seal" in "packages/vault/seal.py" are the same string and
// completely different evidence.
//
// A term's provenance is one of:
//
//   exact-identifier   typed as code and usable whole: SealCorrupt, seal_vault
//   path-token         typed as a location: forge/forgeutil, pricing.mjs
//   natural-language   prose, used for lexical overlap and nothing stronger
//   stopword           filtered before provenance is computed
//
// plus, separately, DERIVED terms -- the parts of a split identifier and the
// stems of an inflected word. Derived terms are lower-confidence evidence and
// are marked as such: they may bring a file into the candidate set, but they
// can never earn the same score as an exact identifier, because "ledger" in
// `fetchLedgerLegacy` is not evidence of a declaration named "ledger".
//
// Provenance is computed from the query text ALONE. It never depends on which
// files happened to be indexed, so the same query always yields the same
// provenance, and it cannot be tuned by editing the corpus.
export const QUERY_TERM_SOURCE = Object.freeze({
  EXACT_IDENTIFIER: "exact-identifier",
  PATH_TOKEN: "path-token",
  NATURAL_LANGUAGE: "natural-language",
  STOPWORD: "stopword",
})

const IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const PATH_SHAPE = /[/\\]|\.[A-Za-z0-9]+$/

export function termSource(term) {
  const value = String(term || "")
  if (STOP.has(value.toLowerCase())) return QUERY_TERM_SOURCE.STOPWORD
  if (PATH_SHAPE.test(value)) return QUERY_TERM_SOURCE.PATH_TOKEN
  if (IDENTIFIER_SHAPE.test(value)) return QUERY_TERM_SOURCE.EXACT_IDENTIFIER
  return QUERY_TERM_SOURCE.NATURAL_LANGUAGE
}

// Words that only ever describe the shape of a request rather than its
// subject. They are already stopwords for candidate purposes; this list exists
// so the derivation step does not manufacture stems out of them.
const SHAPE_WORDS = new Set([
  "definition", "definitions", "declaration", "declarations", "defined",
  "defines", "define", "implementation", "implementations", "implemented",
  "implements", "implement", "usage", "used", "uses", "use", "call", "calls",
  "called", "reference", "references", "referenced", "dependency",
  "dependencies", "dependent", "dependents", "depends", "depend",
])

// English inflection, applied as a DERIVATION and never as a match in its own
// right. "firing" reaches "fire" and "glazing" reaches "glaze"; "string" does
// not reach "str" because the stem is shorter than the evidence threshold.
//
// This is deliberately conservative rather than clever: the only shapes handled
// are the two regular English inflections that map onto a code identifier
// stem, and every stem shorter than MIN_PART_MATCH is discarded rather than
// matched loosely.
function inflectionStems(word) {
  const lower = String(word || "").toLowerCase()
  const stems = new Set()
  // The same threshold the rest of the module uses for a usable name part, so a
  // derived stem is never shorter than a directly matched part would be.
  const add = (value) => {
    const stem = String(value || "").replace(/[^a-z0-9]/g, "")
    if (stem.length >= MIN_PART_MATCH) stems.add(stem)
  }
  if (lower.endsWith("ing") && lower.length > 5) {
    const base = lower.slice(0, -3)
    add(base)
    add(base + "e")
    // "running" -> "runn" -> "run": a doubled consonant collapses.
    if (/([b-df-hj-np-tv-z])\1$/.test(base)) add(base.slice(0, -1))
  }
  if (lower.endsWith("ed") && lower.length > 4) {
    const base = lower.slice(0, -2)
    add(base)
    add(base + "e")
    if (/([b-df-hj-np-tv-z])\1$/.test(base)) add(base.slice(0, -1))
  }
  return [...stems].sort()
}

// Derived evidence for one term: its identifier parts (camel, Pascal, snake,
// kebab and file-stem boundaries all split the same way) plus its inflection
// stems. Bounded, deduplicated and sorted, so the same term always yields the
// same derived list.
export function derivedTermsFor(term) {
  const out = new Set()
  for (const part of identifierParts(term)) {
    const normalized = singular(part)
    if (normalized.length >= MIN_PART_MATCH && !STOP.has(normalized)) out.add(normalized)
  }
  for (const stem of inflectionStems(term)) out.add(stem)
  return [...out].sort()
}

// The provenance record for one query term, plus the derived terms it licenses.
function analyzeTerm(term) {
  const source = termSource(term)
  const derived = source === QUERY_TERM_SOURCE.EXACT_IDENTIFIER ? derivedTermsFor(term) : []
  return {
    term,
    lower: String(term).toLowerCase(),
    source,
    derived,
    // Identifier parts, singular-folded. Used for the unordered bag match that
    // lets `seal_vault` match a file named `test_vault_seal`: name parts are a
    // set, not a sequence, and a test file reverses the order by convention.
    parts: uniqueParts(identifierParts(term)),
    isShapeWord: SHAPE_WORDS.has(String(term).toLowerCase()),
  }
}

function uniqueParts(values) {
  const out = []
  for (const value of values) {
    const normalized = singular(value)
    if (normalized.length >= MIN_PART_MATCH && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

// Full query analysis: the term list, the provenance of each term, and the
// two deterministic INTENT signals the ranking is allowed to use.
//
// Intent is read off the query SHAPE, never off a model and never off the
// candidate set, so the same query yields the same intent on every run:
//
//   testIntent        the query names a test
//   definitionIntent  the query asks WHERE something is defined
//   bindingIntent     the query binds one term to another ("X used to build Y")
//
// The distinction those three carry is the one that separates "where is
// formatAmount defined?" -- the declaring file is the answer -- from "fix the
// LedgerPanel formatting" -- the named component is the answer even though it
// only REFERENCES formatAmount.
const DEFINITION_INTENT_PARTS = new Set([
  "define", "defined", "defines", "definition", "definitions", "declaration",
  "declarations", "declare", "declared", "declares", "implement", "implemented",
  "implements", "implementation", "implementations", "definition-site",
])

const BINDING_PREDICATES = new Set([
  "build", "builds", "building", "built", "reference", "references", "referenced",
  "call", "calls", "called", "cover", "covers", "covering", "consume", "consumes",
  "used", "use", "uses", "using", "via", "through", "from",
])

export function analyzeQuery(query) {
  const raw = String(query || "")
  const terms = queryTerms(raw).map(analyzeTerm)
  const usable = terms.filter((item) => item.source !== QUERY_TERM_SOURCE.STOPWORD)
  const exactIdentifiers = usable
    .filter((item) => item.source === QUERY_TERM_SOURCE.EXACT_IDENTIFIER)
    .filter((item) => !item.isShapeWord && item.parts.length > 0)
  const pathTokens = usable.filter((item) => item.source === QUERY_TERM_SOURCE.PATH_TOKEN)
  const lowerTerms = terms.map((item) => item.lower)
  return {
    query: raw,
    terms,
    // Terms that can carry evidence, in the order they were written.
    usableTerms: usable,
    exactIdentifiers,
    pathTokens,
    lowerTerms,
    testIntent: hasExplicitTestIntent(lowerTerms),
    definitionIntent: usable.some((item) => item.parts.some((part) => DEFINITION_INTENT_PARTS.has(singular(part)))),
    bindingPredicates: usable.filter((item) => item.parts.some((part) => BINDING_PREDICATES.has(part))).map((item) => item.lower),
  }
}

// True when `subject` is covered by `holder` as an unordered bag of identifier
// parts. `seal_vault` is covered by `test_vault_seal`; `seal_vault` is not
// covered by `report`. Order carries no meaning in a name, and the convention
// that reverses it (`<subject>.test.ts` vs `test_<subject>.py`) is a naming
// convention, not a semantic difference.
export function partsCover(holder, subject) {
  if (!subject || !subject.length) return false
  const available = new Set(holder)
  return subject.every((part) => available.has(part))
}

function partsOf(value) {
  return identifierParts(value)
}

// A term matches a name when it equals one of the name's words, or when the
// name's words are a superset containing the term. `smelt` matches `Smelt`,
// `table` matches `LedgerTable`, `route` matches `dispatch_route`. A term of one
// or two characters is excluded: it matches too much to be evidence.
function termMatchesName(term, name) {
  const target = singular(term)
  if (target.length < MIN_PART_MATCH) return false
  const parts = partsOf(name).map(singular)
  if (parts.length === 0) return false
  if (parts.includes(target)) return true
  if (parts.length === 1 && parts[0] === target) return true
  // A multi-word term is satisfied when every one of its words appears.
  const termParts = partsOf(term).map(singular)
  if (termParts.length > 1 && termParts.every((part) => part.length >= MIN_PART_MATCH && parts.includes(part))) return true
  return false
}

// Test markers are part of a file's NAME in five different conventions across
// the corpus under test: `x.test.js`, `x.spec.ts`, `x_test.go`, `test_x.py`, and
// `TestX.java`. Only stripping the dotted forms meant `smelt_test.go` was
// treated as a file named "smelt_test" and stopped pairing with `smelt.go`, so
// the source/test relationship that the ordering rule depends on simply did not
// exist for Go or Python.
function fileStem(file) {
  const base = normalizeMapPath(file).split("/").pop() || ""
  let out = base.replace(/\.[^.]+$/, "")
  out = out.replace(/[._-](test|spec)s?$/i, "")
  out = out.replace(/^(test|spec)[._-]/i, "")
  out = out.replace(/^tests?[._-]/i, "")
  return out
}

// A declaration that belongs to a test BODY rather than to the production API:
// `testApplyTensionScales`, `TestMarkIncreasesDepth`, `spec_forgeutil_signature`.
//
// This is deliberately "some word is test vocabulary", not "only test
// vocabulary": a test function's name restates the unit under test, so the words
// it contributes about coverage are real, but the words it contributes about
// which FILE the query is about are not. The distinction is used for exactly one
// thing -- the coverage measure that resolves the query subject -- and never to
// change a score.
function isTestDeclaration(name) {
  return identifierParts(name).map(singular).some((part) => TEST_INTENT_PARTS.has(part))
}

// HIERARCHICAL PATH GRADING.
//
// The previous implementation graded a path term by matching each of its
// segments independently, which is how `modules/quay` credited
// `modules/dockyard/*` through their shared parent. The grade is now chosen by
// hierarchy (exact file > directory prefix > declared module root > basename >
// single-segment word > raw occurrence), and the rule set lives in
// lib/module-identity.mjs so the ranking and the module resolver cannot disagree
// about what a path means.
//
// The query words are split into two populations here, because they are two
// different kinds of question:
//   pathTokens   terms that name a location (they contain `/` or an extension)
//   wordTerms    everything else
// A path token is never graded as a bare word, and a bare word never claims to
// be a module.
function pathMatchGrades(file, analysis, resolver) {
  const normalized = normalizeMapPath(file)
  const helpers = { matchesName: termMatchesName, stemOf: fileStem }
  const grades = new Set()
  const ownedTerms = new Set()
  for (const item of analysis.terms) {
    // Test markers are metadata about a file, not content of it: without
    // stripping them the query word "test" matched the literal marker inside
    // `glaze_test.go` and every test file became a path match.
    const token = normalizeMapPath(item.term)
    if (token.toLowerCase().split("/").some((segment) => TEST_INTENT_PARTS.has(singular(segment)))) continue
    const graded = gradePathToken({
      file: normalized,
      token,
      tokenSegments: token.toLowerCase().split("/").filter(Boolean),
      resolver,
      helpers,
    })
    if (!graded) continue
    grades.add(graded.grade)
    // Path OWNERSHIP is recorded for the basename grade only. It is what stops a
    // decoy from collecting derived-definition evidence for a term that another
    // candidate owns by name.
    if (graded.grade === "path-basename") ownedTerms.add(item.lower)
  }
  return { grades, ownedTerms }
}

// `const`, `let` and `var` bindings are function-local; a declaration is not.
// The distinction is what separates "this module exports the thing you asked
// for" from "this function happens to have a variable with that name".
const DECLARATION_KINDS = new Set(["function", "class", "interface", "type", "table", "view"])

// Reason -> weight name. Kept in one place so that the reason vocabulary, the
// scoring table and the structural-intent test can never drift apart, and so a
// feature trace can attribute a score completely.
const REASON_WEIGHT = Object.freeze({
  "exact-symbol": "exactSymbol",
  "local-binding": "localBinding",
  "symbol-prefix": "symbolPrefix",
  "symbol-mention": "symbolMention",
  "derived-definition": "derivedDefinition",
  "explicit-path-target": "explicitPathTarget",
  "re-export": "reExport",
  "path-exact": "pathExact",
  "path-prefix": "pathPrefix",
  "path-module-root": "pathModuleRoot",
  "path-basename": "pathBasename",
  "path-segment": "pathSegment",
  "path-partial": "pathPartial",
  "query-module-match": "queryModuleMatch",
  "identifier-reference": "identifierReference",
  // `identifier-reference-only` is a LABEL, not a separate amount of
  // evidence: it records that a row's identifier evidence is a reference and
  // carries no score of its own. Mapping it onto the same weight name is what
  // keeps `sum(reason contributions) == score` exact.
  "identifier-reference-only": "identifierReference",
  "direct-import": "directImport",
  "reverse-reference": "reverseReference",
  "second-hop": "secondHop",
  "convergent-dependency": "convergentDependency",
  "declared": "declared",
  "changed-file": "changedFile",
  "affected-test": "affectedTest",
  "module-sibling": "moduleSibling",
  "hotspot": "hotspot",
  "graph-propagated": "propagated",
  "memory-affinity": "memoryAffinity",
})

// MODULE IDENTITY.
//
// The module of a file is its deepest DECLARED boundary -- a manifest, a Go
// package clause, a workspace member, a Python package, a source root, or the
// child of a directory that only groups directories. Falling back to the parent
// directory keeps every pre-existing layout working when nothing declares a
// boundary, which is why `specs/test_vault_seal.py` is still `specs`.
//
// This is what makes the test/source pairing and the locality signals agree
// with each other: both read the SAME declared boundary, so a test inside
// `packages/quay/test/` is paired with the module `packages/quay` and not with
// whatever file happened to share its stem somewhere else in the tree.
function moduleResolverFor(graph) {
  return createModuleResolver(graph?.moduleRoots || [])
}

export const REPO_MAP_TIER = Object.freeze({
  TARGET: 1,
  NEIGHBOUR: 2,
  TEST: 3,
  SUPPORT: 4,
  HOTSPOT: 5,
})

function tierFor(reasons, file) {
  if (reasons.has("exact-symbol") || reasons.has("declared")) return REPO_MAP_TIER.TARGET
  if (reasons.has("changed-file") || reasons.has("affected-test")) return REPO_MAP_TIER.TARGET
  if (reasons.has("direct-import") || reasons.has("reverse-reference") || reasons.has("test-of-target")) {
    return isTestFile(file) ? REPO_MAP_TIER.TEST : REPO_MAP_TIER.NEIGHBOUR
  }
  if (reasons.has("symbol-prefix") || reasons.has("path-exact") || reasons.has("path-prefix")
    || reasons.has("path-module-root") || reasons.has("path-basename") || reasons.has("path-segment")
    || reasons.has("path-partial") || reasons.has("identifier-reference") || reasons.has("query-module-match")
    || reasons.has("local-binding") || reasons.has("symbol-mention") || reasons.has("module-sibling")
    || reasons.has("derived-definition") || reasons.has("re-export")) {
    return isTestFile(file) ? REPO_MAP_TIER.TEST : REPO_MAP_TIER.SUPPORT
  }
  return REPO_MAP_TIER.HOTSPOT
}

// The exact cost a row will cost the model. Deterministic and derived only from
// the row itself, so a budget cut never depends on iteration order.
export function repoMapRowChars(row) {
  const payload = {
    path: row.path,
    score: Number(row.score || 0),
    tier: row.tier,
    importantSymbols: (row.importantSymbols || []).slice(0, REPO_MAP_DEFAULTS.maxSymbolsPerFile),
    relationship: row.relationship || null,
    testLinks: (row.testLinks || []).slice(0, REPO_MAP_DEFAULTS.testLinksPerFile),
  }
  return JSON.stringify(payload).length + 1
}

function stableCompare(a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (a.tier !== b.tier) return a.tier - b.tier
  return a.path.localeCompare(b.path)
}

// A NaN score sorts unpredictably and silently: every comparison against it is
// false, so a whole tier of candidates can vanish or float to the top without
// any error. Weight lookups are therefore total by construction -- an unknown
// key contributes nothing instead of poisoning the row -- and a row that still
// ends up non-finite is dropped rather than ranked.
function weightOf(name) {
  const value = Number(REPO_MAP_WEIGHTS[name])
  return Number.isFinite(value) ? value : 0
}

export function isRankableScore(value) {
  return Number.isFinite(Number(value))
}

export function clearRepoMapRuntimeCache() {
  clearSemanticIndexRuntimeCache()
  clearRepoGraphRuntimeCache()
}

export async function buildRepoMap(root = process.cwd(), rawQuery = "", options = {}) {
  const limits = { ...REPO_MAP_DEFAULTS, ...(options.limits || {}) }
  root = path.resolve(root)
  const query = String(rawQuery || "")
  const analysis = analyzeQuery(query)
  const terms = analysis.terms.map((item) => item.term)
  const lowerTerms = analysis.lowerTerms
  const started = Date.now()

  const semantic = options.builtSemantic
    || await buildSemanticIndexCached(root, {
      maxFiles: options.maxFiles ?? limits.maxFiles,
      workspaceFingerprint: options.workspaceFingerprint || "",
    })
  const graph = options.builtGraph
    || await buildRepoGraphCached(root, { maxFiles: options.maxFiles ?? limits.maxFiles })

  const declared = [...new Set((options.declaredFiles || []).map(normalizeMapFile).filter(Boolean))]
  const changed = [...new Set((options.changedFiles ?? safeChangedFiles(root)).map(normalizeMapFile).filter(Boolean))]

  // ---- stage 1: candidate generation ------------------------------------
  const lexical = terms.length
    ? await querySemanticIndex(root, query, {
      maxFiles: options.maxFiles ?? limits.maxFiles,
      limit: Math.max(limits.maxCandidates, 40),
      builtIndex: semantic,
    })
    : { results: [] }

  const rows = new Map()
  const ensure = (file) => {
    const path_ = normalizeMapFile(file)
    if (!path_ || !isWorkspaceRelativeMapPath(path_)) return null
    let row = rows.get(path_)
    if (!row) {
      row = {
        path: path_,
        score: 0,
        lexical: 0,
        reasons: new Set(),
        symbols: new Map(),
        propagated: 0,
        tests: [],
      }
      rows.set(path_, row)
    }
    return row
  }

  // The word-boundary predicate, exposed for the evidence ladder below. It is
  // the same rule the rest of the module already used for names: a term matches
  // a name when it equals one of the name's words. `seal` matches `seal_vault`
  // and `sealVault`; it does not match `seam`.
  const nameWords = new Map()
  const wordCount = (name) => {
    const key = String(name || "")
    if (!nameWords.has(key)) nameWords.set(key, identifierParts(key).map(singular))
    return nameWords.get(key)
  }
  const symbolWords = (name) => wordCount(name)
  const coversWord = (name, term) => {
    const words = symbolWords(name)
    // The ORIGINAL term is used to split, never a pre-lowercased copy:
    // `identifierParts` works on case boundaries, so "LedgerPanel" must still be
    // PascalCase when it is tokenised. Lower-casing first turned it into the
    // single part "ledgerpanel", which matches nothing -- and silently disabled
    // every camel/Pascal bag match in the module.
    const target = singular(term.toLowerCase())
    if (!words.length || target.length < MIN_PART_MATCH) return false
    if (words.includes(target)) return true
    if (words.length === 1 && words[0] === target) return true
    const subject = uniqueParts(identifierParts(term))
    return subject.length > 0 && partsCover(words, subject)
  }
  const isRawPrefix = (name, termLower) => {
    // A two-letter fragment is not evidence. `"or"` occurs inside almost every
    // file name, so a raw substring rule turned "now or elapsed" into a hit on
    // `SealCorrupt` via the letters "or". Raw substring matching therefore has
    // the same minimum part length as word matching.
    if (termLower.length < MIN_PART_MATCH) return false
    const lower = String(name || "").toLowerCase()
    return lower.startsWith(termLower) || lower.includes(termLower)
  }

  const exactIdentifierTerms = new Set(analysis.exactIdentifiers.map((item) => item.lower))
  void exactIdentifierTerms

  let candidateCount = 0
  const symbolEvidence = new Map()
  const recordEvidence = (file, reason, detail) => {
    const key = file + "\u0000" + reason
    const current = symbolEvidence.get(key) || { file, reason, detail, terms: new Set() }
    current.terms.add(detail)
    symbolEvidence.set(key, current)
  }
  // PATH OWNERSHIP, decided before any symbol grade is read.
  //
  // `pricing` must not be satisfied by `legacyPricingSheet`. A file literally
  // NAMED by the query term is better evidence for that term than a file whose
  // declaration happens to embed the word, and the pre-repair ranking got this
  // backwards badly enough that the decoy outscored the target.
  //
  // The rule is computed over the bounded candidate set, once: if any candidate
  // owns term T on its path basename, no OTHER candidate may collect
  // derived-definition or symbol-prefix evidence for T. The owner is unaffected
  // and so is every other term.
  const pathGrades = new Map()
  const basenameOwners = new Map()
  const resolver = moduleResolverFor(graph)
  const moduleOf = (file) => resolver.moduleOf(file)
  for (const result of lexical.results || []) {
    const file = normalizeMapFile(result.path)
    if (!file) continue
    const { grades, ownedTerms } = pathMatchGrades(file, analysis, resolver)
    if (grades.size) pathGrades.set(file, grades)
    for (const term of ownedTerms) {
      const owners = basenameOwners.get(term) || new Set()
      owners.add(file)
      basenameOwners.set(term, owners)
    }
  }
  const ownedByAnother = (file, term) => {
    const owners = basenameOwners.get(term)
    return Boolean(owners && owners.size && !owners.has(file))
  }
  for (const result of lexical.results || []) {
    const row = ensure(result.path)
    if (!row) continue
    candidateCount += 1
    row.lexical = Number(result.score || 0)
    const entry = (semantic.index?.files || {})[row.path] || {}
    const declaredByName = new Map((entry.symbols || []).map((symbol) => [String(symbol.name || ""), symbol]))
    const kinds = new Map([...declaredByName].map(([name, symbol]) => [name, String(symbol.kind || "")]))
    const declaredNames = [...kinds.keys()]
    // MODULE SCOPE vs BLOCK SCOPE, without a parser.
    //
    // The index reports `const`/`let`/`var` uniformly as "binding", and the
    // ranking then graded ALL of them as a function-local (6 points), so a
    // module's own exported constant scored a fortieth of a declaration and its
    // importer outranked it in a three-file cycle.
    //
    // The scope test uses the one thing the index records that survives
    // trimming: whether the declaration is EXPORTED. An exported binding is the
    // module's public surface and IS a definition; an unexported one is not
    // claimed, whatever its scope.
    //
    // Leading whitespace is NOT usable here: the index stores `preview` already
    // trimmed, so indentation -- the only other scope signal -- has been thrown
    // away, and reading it back would mark a `const` inside a function body as a
    // module declaration. Under-claiming a declaration is safe; inventing one is
    // not.
    const isModuleScope = (symbol) => {
      if (DECLARATION_KINDS.has(String(symbol?.kind || ""))) return true
      if (String(symbol?.kind || "") !== "binding") return false
      return /^\s*export\s/.test(String(symbol?.preview ?? ""))
    }

    // DEFINITION vs REFERENCE, separated here and never merged again.
    //
    // The previous pass collapsed both into "symbol match", so a file that
    // merely mentioned an identifier eight times scored like the file that
    // defined it, and a derived word inside a longer identifier scored like the
    // identifier itself. Three distinct facts are now recorded separately:
    //
    //   exact-symbol       the file DECLARES a symbol whose name IS the term
    //   derived-definition  the file DECLARES a symbol whose WORDS cover the
    //                      term (or one of its derived stems)
    //   symbol-mention     the file only CONTAINS the identifier, or declares
    //                      some other symbol that happens to contain the term
    //
    // Repetition never promotes a mention: `identifier-reference` stays flat.
    for (const term of analysis.usableTerms) {
      const lower = term.lower
      const exactName = declaredNames.find((name) => name.toLowerCase() === lower)
      if (exactName) {
        if (DECLARATION_KINDS.has(kinds.get(exactName) || "") || isModuleScope(declaredByName.get(exactName))) {
          row.reasons.add("exact-symbol")
          row.symbols.set(exactName, "exact")
          recordEvidence(row.path, "exact-symbol", exactName)
          continue
        }
        row.reasons.add("local-binding")
        row.symbols.set(exactName, "local")
        recordEvidence(row.path, "local-binding", exactName)
        continue
      }
      const covering = ownedByAnother(row.path, lower) ? null : declaredNames.find((name) => coversWord(name, term.term))
      if (covering) {
        row.reasons.add("derived-definition")
        row.symbols.set(covering, "derived")
        recordEvidence(row.path, "derived-definition", covering)
        continue
      }
      const rawPrefix = ownedByAnother(row.path, lower) ? null : declaredNames.find((name) => isRawPrefix(name, lower))
      if (rawPrefix) {
        row.reasons.add("symbol-prefix")
        row.symbols.set(rawPrefix, "prefix")
        recordEvidence(row.path, "symbol-prefix", rawPrefix)
      }
    }
    for (const reason of result.reasons || []) {
      if (reason.startsWith("definition:")) continue
      if (reason.startsWith("symbol:")) continue
      if (reason.startsWith("reference:")) row.reasons.add("identifier-reference")
    }
    // A file that only mentions the identifier is a REFERENCE, and it is
    // labelled as one whatever else it matched.
    const mentionsOnly = !row.reasons.has("exact-symbol") && !row.reasons.has("derived-definition")
      && row.reasons.has("identifier-reference")
    if (mentionsOnly) row.reasons.add("identifier-reference-only")
    // The path grades are computed here rather than read from the lexical result,
    // which reports a flat substring hit and cannot tell a definition from a
    // directory that happens to share a word.
    const grades = pathGrades.get(row.path)
    if (grades) for (const grade of grades) row.reasons.add(grade)
    for (const definition of result.definitions || []) {
      // A lexical `definitions` entry only means "this symbol was matched",
      // which is weaker than the grade already computed above. It may ADD a
      // symbol to the row's list, but it may not overwrite an existing grade:
      // doing so silently turned every `derived-definition` into an
      // unclassified `definition`, and the query-subject rule -- which reads
      // those grades -- stopped firing on every mention-shaped row.
      const name = String(definition?.name || "")
      if (name && !row.symbols.has(name)) row.symbols.set(name, "definition")
    }
  }

  // MODULE-TOKEN DISAMBIGUATION.
  //
  // `glaze SetPoint` names a module and a symbol. `glaze` also happens to be a
  // declared function in `glaze.go`, and letting that count as an exact
  // definition made the module's own file outrank the file that defines the
  // symbol the query is about.
  //
  // The rule is structural and local: when the query names more than one
  // identifier-shaped term, a term that is ALSO a directory of some candidate is
  // a module token, and its symbol evidence is downgraded to a mention -- the
  // same evidence it already has from the path. A single-term query has no such
  // conflict, so `Glaze` on its own still resolves to the file that defines it.
  const termIsSymbolic = (termLower) => {
    const owners = []
    for (const [file, entry] of Object.entries(semantic.index?.files || {})) {
      for (const symbol of entry.symbols || []) {
        if (String(symbol.name || "").toLowerCase() === termLower) owners.push([file, String(symbol.kind || "")])
      }
    }
    return owners
  }
  const moduleTokenDowngrades = new Map()
  if (analysis.exactIdentifiers.length >= 2) {
    const directories = new Set()
    for (const file of Object.keys(semantic.index?.files || {})) {
      for (const segment of normalizeMapPath(file).toLowerCase().split("/").slice(0, -1)) directories.add(segment)
    }
    for (const item of analysis.exactIdentifiers) {
      if (!directories.has(item.lower)) continue
      const owners = termIsSymbolic(item.lower)
      if (!owners.length) continue
      moduleTokenDowngrades.set(item.lower, owners)
    }
  }
  for (const [lower, owners] of moduleTokenDowngrades) {
    for (const [file, kind] of owners) {
      const row = rows.get(file)
      if (!row) continue
      if (DECLARATION_KINDS.has(kind)) {
        if (row.reasons.has("exact-symbol")) {
          row.reasons.delete("exact-symbol")
          row.reasons.add("symbol-mention")
          if (!row.reasons.has("identifier-reference")) row.reasons.add("identifier-reference")
          row.symbols.delete([...row.symbols.entries()].find(([, value]) => value === "exact")?.[0])
        }
      }
      moduleTokenDowngrades.delete(lower)
    }
  }

  // QUERY-MODULE-MATCH.
  //
  // The downgrade above can only fire when the module term is ALSO a declared
  // symbol -- `glaze` names a function in `glaze.go`, so its own file was
  // demoted. A term that names a module but no symbol (`dockyard` naming a
  // package directory) earned nothing at all, and two packages declaring the
  // same symbol stayed tied on everything else. That is the whole defect:
  // `dockyard package BerthRegistry` ranked the quay copy first.
  //
  // The rule here is deliberately the weakest positive signal in the table and
  // it binds ONLY to a DECLARED boundary: a package.json name, a Go package
  // clause, a Python package, a workspace member, a source root, or the child of
  // a directory that only groups directories. "modules" is a grouping prefix,
  // not a module, so naming it credits nothing; naming `quay` credits exactly
  // the module `quay`.
  //
  // Because it is awarded only to the module the query named, and never to a
  // file merely because that file declares the queried symbol, it can break a
  // same-symbol tie without ever overturning a declaration.
  const moduleTermTokens = new Set(resolver.identities)
  const moduleTerms = analysis.exactIdentifiers
    .filter((item) => !item.isShapeWord && !isTestVocabulary(item.term))
    .map((item) => item.lower)
    .filter((term) => moduleTermTokens.has(term))
  if (moduleTerms.length) {
    for (const row of rows.values()) {
      const root = resolver.rootFor(row.path)
      if (!root) continue
      const identities = new Set(identityTokens(root))
      if (!moduleTerms.some((term) => identities.has(term))) continue
      row.reasons.add("query-module-match")
      row.moduleIdentity = root.identity || ""
      row.moduleRoot = root.dir
    }
  }

  for (const file of declared) {
    const row = ensure(file)
    if (!row) continue
    row.reasons.add("declared")
  }
  for (const file of changed) {
    const row = ensure(file)
    if (!row) continue
    row.reasons.add("changed-file")
  }

  // Import neighbours of the declared and changed files are always relevant
  // evidence: touching a file means its callees and callers matter, whether or
  // not the query text happened to mention them.
  const nodeByPath = new Map((graph.nodes || []).map((node) => [normalizeMapPath(node.path), node]))
  const incoming = new Map()
  // Edges are kept with their kind so a re-export stays distinguishable from a
  // plain import and from "this file happens to be central".
  const typedEdges = []
  for (const edge of graph.edges || []) {
    const from = normalizeMapPath(edge.from)
    const to = normalizeMapPath(edge.to)
    const list = incoming.get(to) || []
    list.push(from)
    incoming.set(to, list)
    typedEdges.push({ from, to, kind: String(edge.kind || "local-import") })
  }
  for (const list of incoming.values()) list.sort()
  const anchorFiles = [...new Set([...declared, ...changed])]
  for (const file of anchorFiles) {
    for (const target of nodeByPath.get(file)?.localImports || []) {
      ensure(target)?.reasons.add("direct-import")
      candidateCount += 1
    }
    for (const source of incoming.get(file) || []) {
      ensure(source)?.reasons.add("reverse-reference")
      candidateCount += 1
    }
  }

  // RELATIONSHIP-FIRST CANDIDATE GENERATION (Phase 3A).
  //
  // The previous pass seeded a generic personalized-PageRank with the scored
  // candidates and then admitted every node it reached, which means a file got
  // on the map for being two hops away from something popular. Centrality is
  // not a relationship: `packages/shared/telemetry.mjs` is imported by half the
  // repository and is the answer to nothing.
  //
  // Instead, each DEFINITION seed (a file the query actually resolves to) is
  // expanded along real edges, and every generated candidate records exactly
  // which edge produced it. A candidate reached by a re-export is not the same
  // fact as a candidate reached because the file is central, and the two must
  // never collapse into one reason.
  //
  // Bounds are per seed and global: a file with more dependents than
  // `maxDependentsPerSeed` is treated as central and not expanded, and the
  // candidate cap is enforced as candidates are created.
  const relationshipProvenance = new Map()
  let graphExpansionCount = 0
  const noteRelationship = (row, entry) => {
    if (!row) return
    const list = relationshipProvenance.get(row.path) || []
    list.push(entry)
    relationshipProvenance.set(row.path, list)
    if (entry.edgeKind === "re-export") row.reasons.add("re-export")
    if (entry.depth <= 1) graphExpansionCount += 1
  }
  const definitionSeeds = [...rows.values()]
    .filter((row) => row.reasons.has("exact-symbol") || row.reasons.has("declared")
      || row.reasons.has("changed-file") || row.reasons.has("derived-definition")
      || row.reasons.has("local-binding") || row.reasons.has("path-basename"))
    // A test file is never a seed. Its declarations restate the name of the
    // unit under test, so expanding its imports pulled the SOURCE into the map
    // as a "dependency of the test" and let the test's own subject outrank the
    // file that defines it. Tests are evidence about a subject, not subjects.
    .filter((row) => !isTestFile(row.path))
    .sort((a, b) => tierFor(a.reasons, a.path) - tierFor(b.reasons, b.path) || a.path.localeCompare(b.path))
    .slice(0, limits.maxRelationshipSeeds)
  const maxDependentsPerSeed = Math.max(2, Number(limits.maxDependentsPerSeed ?? 12))
  for (const seed of definitionSeeds) {
    const dependencies = (nodeByPath.get(seed.path)?.localImports || []).slice(0, maxDependentsPerSeed)
    const dependents = (incoming.get(seed.path) || []).slice(0, maxDependentsPerSeed)
    // A seed with more dependents than the cap is a hub, not a subject: its
    // callers say nothing about why the query asked about this file.
    if ((incoming.get(seed.path) || []).length > maxDependentsPerSeed) dependents.length = 0
    for (const target of dependencies) {
      if (rows.size >= limits.maxCandidates) break
      const row = ensure(target)
      const kind = typedEdges.find((edge) => edge.from === seed.path && edge.to === target)?.kind || "local-import"
      if (row && !row.reasons.has("direct-import")) {
        row.reasons.add("direct-import")
        candidateCount += 1
      }
      noteRelationship(row, { reason: kind === "re-export" ? "re-export" : "direct-import", from: seed.path, to: target, depth: 1, edgeKind: kind })
    }
    for (const source of dependents) {
      if (rows.size >= limits.maxCandidates) break
      const row = ensure(source)
      const kind = typedEdges.find((edge) => edge.from === source && edge.to === seed.path)?.kind || "local-import"
      if (row && !row.reasons.has("reverse-reference")) {
        row.reasons.add("reverse-reference")
        candidateCount += 1
      }
      noteRelationship(row, { reason: "reverse-reference", from: source, to: seed.path, depth: 1, edgeKind: kind })
    }
    // RE-EXPORT CHAIN.
    //
    // A file that imports the BARREL that re-exports the seed is a direct user
    // of the seed, not a second-degree one. `checkout.mjs -> billing/index ->
    // invoice.mjs` is one hop from a reader's point of view, and treating the
    // barrel as an opaque middle hop is exactly why "buildInvoiceSummary
    // callers" could not see the only caller in the workspace.
    //
    // The chain is followed through re-export edges only, one barrel deep, and
    // it is capped: a hub that re-exports half the repository contributes
    // nothing rather than everything.
    const reExporters = (incoming.get(seed.path) || []).filter((from) => {
      const kind = typedEdges.find((edge) => edge.from === from && edge.to === seed.path)?.kind
      return kind === "re-export"
    })
    if (reExporters.length && reExporters.length <= maxDependentsPerSeed) {
      for (const barrel of reExporters) {
        for (const consumer of (incoming.get(barrel) || []).slice(0, maxDependentsPerSeed)) {
          if (rows.size >= limits.maxCandidates) break
          const row = ensure(consumer)
          if (!row) continue
          if (!row.reasons.has("reverse-reference")) {
            row.reasons.add("reverse-reference")
            candidateCount += 1
          }
          noteRelationship(row, { reason: "reverse-reference", from: consumer, to: seed.path, depth: 1, edgeKind: "re-export-chain" })
        }
      }
    }
  }

  // Second hop, bounded, decayed and cycle-safe: a neighbour of a neighbour is
  // usually context, so it is admitted as a candidate but can never outrank the
  // file it is two hops from.
  if (limits.propagationDepth >= 2) {
    const firstHop = new Set(definitionSeeds.map((row) => row.path))
    const queue = []
    for (const seed of definitionSeeds) {
      for (const target of (nodeByPath.get(seed.path)?.localImports || []).slice(0, maxDependentsPerSeed)) queue.push([target, seed.path])
      for (const source of (incoming.get(seed.path) || []).slice(0, maxDependentsPerSeed)) queue.push([source, seed.path])
    }
    const visited = new Set(firstHop)
    let processed = 0
    for (const [file, from] of queue) {
      if (processed >= limits.maxSecondHop) break
      processed += 1
      if (visited.has(file)) continue
      visited.add(file)
      if (rows.size >= limits.maxCandidates) break
      const row = ensure(file)
      if (!row) continue
      const kind = typedEdges.find((edge) => edge.from === from && edge.to === file)?.kind || "local-import"
      row.reasons.add("second-hop")
      row.secondHopFrom = from
      candidateCount += 1
      noteRelationship(row, { reason: "second-hop", from, to: file, depth: 2, edgeKind: kind })
    }
  }

  // CONVERGENT DEPENDENCY.
  //
  // When the query names two or more things and ONE file depends on two or more
  // of them, that file is the integration point: it is where the query's
  // subjects meet. That is a specific, checkable fact about the graph, and it is
  // not the same as being central -- a utility imported everywhere does not
  // depend on two query-named modules unless the query named them.
  const convergent = new Map()
  for (const term of analysis.exactIdentifiers) {
    for (const file of rows.keys()) {
      const evidence = symbolEvidence.get(file + "\u0000exact-symbol")
      if (!evidence) continue
      const covered = evidence.detail.toLowerCase() === term.lower
      if (!covered) continue
      for (const source of incoming.get(file) || []) {
        const list = convergent.get(source) || new Set()
        list.add(file)
        convergent.set(source, list)
      }
    }
  }
  for (const [source, dependencies] of convergent) {
    if (dependencies.size < 2) continue
    if (rows.size >= limits.maxCandidates) break
    const row = ensure(source)
    if (!row) continue
    row.reasons.add("convergent-dependency")
    row.convergentOn = [...dependencies].sort().slice(0, 4)
    candidateCount += 1
  }

  // Affected tests, bounded and failure-tolerant: a missing or slow test
  // inventory must degrade the map, never fail it.
  let affected = { tests: [], degraded: false }
  if (anchorFiles.length) {
    affected = await resolveAffectedTests(root, { maxTests: 60 }).catch(() => ({ tests: [], degraded: true }))
  }
  for (const test of affected.tests || []) {
    const row = ensure(test.file || test.test || test.path)
    if (!row) continue
    row.reasons.add("affected-test")
    row.tests = [...new Set([...(row.tests || []), ...(test.changedFiles || [])])].slice(0, 8)
  }

  // ---- stage 2: feature scoring ----------------------------------------
  // Every non-zero contribution is recorded as `{reason, weight, points}` as it
  // is added, and the row's score is the sum of that list. The invariant
  //
  //     sum(row.contributions[].points) == row.score
  //
  // is what makes the map explainable, and it is asserted by a regression test
  // over every ranked row. There is no residual term and no unattributed
  // arithmetic left anywhere in the scoring path.
  const maxLexical = Math.max(1, ...[...rows.values()].map((row) => row.lexical))
  const selectedModules = new Set([...declared, ...changed].map(moduleOf))
  const applyFeature = (row, reason, weightName, scale = 1) => {
    const weight = weightOf(weightName)
    const points = weight * (scale === 1 ? 1 : scale)
    if (!Number.isFinite(points) || points === 0) return
    row.score += points
    row.contributions.push({ reason, weight, points: Number(points.toFixed(6)) })
  }
  for (const row of rows.values()) {
    row.contributions = []
    row.score = 0
    if (row.reasons.has("exact-symbol")) applyFeature(row, "exact-symbol", "exactSymbol")
    if (row.reasons.has("declared")) applyFeature(row, "declared", "declared")
    if (row.reasons.has("changed-file")) applyFeature(row, "changed-file", "changedFile")
    if (row.reasons.has("affected-test")) applyFeature(row, "affected-test", "affectedTest")
    if (row.reasons.has("direct-import")) applyFeature(row, "direct-import", "directImport")
    if (row.reasons.has("reverse-reference")) applyFeature(row, "reverse-reference", "reverseReference")
    if (row.reasons.has("convergent-dependency")) applyFeature(row, "convergent-dependency", "convergentDependency")
    if (row.reasons.has("second-hop")) applyFeature(row, "second-hop", "secondHop")
    if (row.reasons.has("re-export")) applyFeature(row, "re-export", "reExport")
    if (row.reasons.has("symbol-prefix")) applyFeature(row, "symbol-prefix", "symbolPrefix")
    if (row.reasons.has("symbol-mention")) applyFeature(row, "symbol-mention", "symbolMention")
    if (row.reasons.has("local-binding")) applyFeature(row, "local-binding", "localBinding")
    if (row.reasons.has("derived-definition")) {
      // Coverage grading: a declaration that spans several of the query's own
      // words is the declaration the query is about. The ceiling keeps derived
      // evidence strictly below an exact identifier definition.
      const covered = new Set()
      // COVERAGE vs SUBJECT COVERAGE.
      //
      // These are two different facts and they were being read as one. `covered`
      // counts what the file's declarations say about the query's words, which is
      // real evidence and stays scored. `subjectCoverage` counts the same thing
      // EXCLUDING declarations that belong to a test body, and it is the only
      // input to subject resolution.
      //
      // A test function restates the unit it covers -- `testSealVaultRoundtrip`
      // covers both "seal" and "vault" in one name -- so counting it made a test
      // file the best explanation of a query that never mentioned a test, and
      // the resolved-subject bonus then lifted it to first place. The coverage is
      // still recorded, still published and still labelled `test-covers-subject`;
      // it simply may not decide which FILE the query is about.
      const subjectCovered = new Set()
      const isTestRow = isTestFile(row.path)
      for (const [name, value] of row.symbols) {
        if (value !== "derived") continue
        const words = new Set(identifierParts(name).map(singular))
        const testDeclaration = isTestRow && isTestDeclaration(name)
        for (const item of analysis.exactIdentifiers) {
          if (item.isShapeWord) continue
          if (isTestVocabulary(item.term)) continue
          if (partsCover(words, item.parts) || item.derived.some((stem) => words.has(singular(stem)))) {
            covered.add(item.lower)
            if (!testDeclaration) subjectCovered.add(item.lower)
          }
        }
      }
      const coverage = Math.max(1, covered.size)
      const ceiling = weightOf("derivedDefinitionCeiling")
      const wanted = weightOf("derivedDefinition") + weightOf("derivedDefinitionCoverageStep") * (coverage - 1)
      const scale = wanted <= 0 ? 0 : Math.min(1, ceiling / wanted)
      applyFeature(row, "derived-definition", "derivedDefinition", scale)
      row.derivedCoverage = coverage
      row.subjectCoverage = subjectCovered.size
      if (coverage > 1) row.reasons.add("query-subject-anchor")
    }
    if (row.reasons.has("query-module-match")) applyFeature(row, "query-module-match", "queryModuleMatch")
    if (row.reasons.has("path-exact")) applyFeature(row, "path-exact", "pathExact")
    if (row.reasons.has("path-prefix")) applyFeature(row, "path-prefix", "pathPrefix")
    if (row.reasons.has("path-module-root")) applyFeature(row, "path-module-root", "pathModuleRoot")
    if (row.reasons.has("path-basename")) applyFeature(row, "path-basename", "pathBasename")
    if (row.reasons.has("path-segment")) applyFeature(row, "path-segment", "pathSegment")
    if (row.reasons.has("path-partial")) applyFeature(row, "path-partial", "pathPartial")
    if (row.reasons.has("identifier-reference")) applyFeature(row, "identifier-reference", "identifierReference")
    // Lexical evidence is normalised, so a long query cannot outweigh an exact
    // symbol definition and a short one cannot be ignored.
    // Normalised lexical mass, made explicit and kept subordinate.
    //
    // This term used to be added with no `reason`, so between 9 and 28 points of
    // every score were unattributable -- the feature trace showed residuals of
    // that size and the map could not explain itself. It is now a named signal
    // (`lexical-overlap`) and it is capped below the smallest structural
    // declaration signal, so raw word overlap can break a tie between
    // structurally equal candidates but can never outrank one that declares what
    // the query asked for.
    const lexicalMass = (row.lexical / maxLexical) * weightOf("exactSymbol") * 0.25;
    if (lexicalMass > 0) applyFeature(row, "lexical-overlap", "exactSymbol", lexicalMass / weightOf("exactSymbol"))
    if (selectedModules.size && selectedModules.has(moduleOf(row.path)) && !row.reasons.has("declared")) {
      row.reasons.add("module-sibling")
      applyFeature(row, "module-sibling", "moduleSibling")
    }
    if (lexicalMass > 0) row.lexicalMass = lexicalMass
  }

  // ---- stage 3: bounded centrality adjustment --------------------------
  //
  // The personalized-PageRank is KEPT, and it is kept for exactly one thing: as
  // a small tie-breaker among files that are already candidates on real
  // evidence. It is no longer allowed to INTRODUCE a candidate.
  //
  // That is the whole Phase 3A repair. Previously every node the ranker reached
  // was admitted to the map, so a repository with real import edges leaked
  // unrelated packages into the top of an unrelated module's ranking: the
  // fixture's own locality test caught `packages/core/src/pricing.mjs` at rank
  // four of a `packages/billing` query, reached purely by centrality. The
  // candidates are now generated by relationships; centrality may only reorder
  // them.
  const seeds = [...rows.values()]
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limits.maxPropagationNodes)
  const seedByPath = new Map(seeds.map((row) => [row.path, row.score]))

  const propagated = rankContextGraph(graph, {
    semanticResults: seeds.map((row) => ({ path: row.path, score: row.score })),
    declared: anchorFiles,
    changed,
    limit: limits.maxPropagationNodes,
  })
  for (const item of propagated) {
    const row = rows.get(item.path)
    // No `ensure()` here: a node that has no evidence of its own stays off the
    // map, however central it is.
    if (!row) continue
    row.propagated = Number(item.pageRank || 0)
  }

  // Hotspots are a last-resort filler, never a primary signal. A high-centrality
  // utility file must not outrank the file that actually defines the symbol.
  const incomingCounts = new Map()
  for (const edge of graph.edges || []) {
    const to = normalizeMapPath(edge.to)
    incomingCounts.set(to, (incomingCounts.get(to) || 0) + 1)
  }
  const maxIncoming = Math.max(0, ...incomingCounts.values())

  // ---- memory affinity (verified-only, bounded, never dominant) ---------
  const memory = verifiedMemoryAffinity(options)

  const prepared = [...rows.values()].map((row) => {
    if (maxIncoming > 0) {
      const centrality = (incomingCounts.get(row.path) || 0) / maxIncoming
      if (centrality > 0) {
        row.reasons.add("hotspot")
        const weight = weightOf("hotspot")
        const points = weight * centrality
        row.score += points
        row.contributions.push({ reason: "hotspot", weight, points: Number(points.toFixed(6)) })
      }
    }
    if (row.lexicalMass > 0) row.reasons.add("lexical-overlap")
    const affinity = memory.get(row.path) || 0
    if (affinity > 0) {
      row.reasons.add("memory-affinity")
      // Hard-capped: below every direct code signal, so a remembered opinion
      // can break a tie and nothing more.
      const weight = weightOf("memoryAffinity")
      const points = Math.min(weight, Math.max(0, Number(affinity)) * weight)
      row.score += points
      row.contributions.push({ reason: "memory-affinity", weight, points: Number(points.toFixed(6)) })
    }
    const relationship = describeRelationship(row, nodeByPath, incoming, anchorFiles)
    // The score is re-summed from the recorded contributions rather than carried
    // through, so the published number is by construction the sum of the reasons
    // published beside it. Anything unattributed would show up here immediately.
    const attributed = Number(row.contributions.reduce((sum, item) => sum + Number(item.points || 0), 0).toFixed(6))
    row.score = attributed
    return {
      path: row.path,
      score: attributed,
      contributions: row.contributions.map((item) => ({ ...item })),
      lexical: Number(row.lexical.toFixed(3)),
      propagated: Number(row.propagated.toFixed(10)),
      tier: tierFor(row.reasons, row.path),
      // How many distinct query content words ONE declaration of this file
      // covers. It is the evidence the query-subject rule reads, so it is
      // published rather than kept private.
      derivedCoverage: Number(row.derivedCoverage || 0),
      // Coverage measured EXCLUDING declarations that belong to a test body.
      // This is the only input to subject resolution; see the note beside
      // `derivedCoverage` above.
      subjectCoverage: Number(row.subjectCoverage || 0),
      moduleIdentity: row.moduleIdentity || null,
      reasons: [...row.reasons].sort(),
      importantSymbols: [...row.symbols.keys()].slice(0, limits.maxSymbolsPerFile),
      relationships: (relationshipProvenance.get(row.path) || []).slice(0, limits.maxRelationshipsPerRow),
      relationship,
      testLinks: row.tests.slice(0, limits.testLinksPerFile),
      seed: seedByPath.has(row.path),
    }
  })

  // Tests belonging to a selected source file are linked onto that file, and
  // the test file itself is ranked as a neighbour rather than as a hotspot.
  const testIndex = prepared.filter((row) => isTestFile(row.path))
  for (const row of prepared) {
    if (isTestFile(row.path)) continue
    const stem = row.path.split("/").pop().replace(/\.[^.]+$/, "")
    const links = testIndex
      .filter((test) => test.path.includes(stem) || row.reasons.includes("changed-file"))
      .slice(0, limits.testLinksPerFile)
      .map((test) => test.path)
    if (links.length) {
      row.testLinks = [...new Set([...row.testLinks, ...links])].slice(0, limits.testLinksPerFile)
      if (!row.reasons.includes("test-of-target")) row.reasons = [...row.reasons, "test-of-target"].sort()
    }
  }

  // ---- test / source relationship -------------------------------------
  //
  // A test never outranks the source it covers -- UNLESS the query was actually
  // asking about the test, in which case demoting it answers a question nobody
  // asked. Both halves of that used to be broken.
  //
  // INTENT IS DERIVED FROM THE CANDIDATES, NOT FROM A KEYWORD LIST. The
  // pre-repair code tested the query for the literal words "test"/"spec"/
  // "coverage", which is a keyword list that cannot generalise, and the ordering
  // constraint built on top of it was dead code: the first emission pass drained
  // a `deferred` map that the second pass only populated afterwards, so the rule
  // never fired for any query, and only the blunt score penalty was doing
  // anything. The test-lookup regression was that penalty, alone, failing.
  //
  // Instead: intent holds when a test file carries STRUCTURAL evidence at least
  // as strong as the best non-test candidate's. That is a property of the
  // candidate set, so it needs no vocabulary, works in any language, and cannot
  // be gamed by adding a word to a query.
  const STRUCTURAL_REASONS = new Set([
    "exact-symbol", "declared", "changed-file", "path-basename",
    "direct-import", "reverse-reference", "affected-test",
  ])
  const structuralScore = (row) => (row.reasons || [])
    .filter((reason) => STRUCTURAL_REASONS.has(reason))
    .reduce((sum, reason) => sum + (REASON_WEIGHT[reason] || 0), 0)
  void structuralScore

  const sourceByStem = new Map()
  const sourceStemsByModule = new Map()
  for (const row of prepared) {
    if (isTestFile(row.path)) continue
    const stem = singular(fileStem(row.path))
    sourceByStem.set(stem, row.path)
    const module = moduleOf(row.path)
    const stems = sourceStemsByModule.get(module) || new Map()
    stems.set(stem, row.path)
    sourceStemsByModule.set(module, stems)
  }
  // Module-aware pairing. `packages/spool/test/spool.spec.ts` does not share a
  // stem with `packages/spool/src/index.ts` -- its stem is "spool" and the
  // module entry's stem is "index" -- so the test had no source to be ranked
  // below and outranked the very module the query named.
  //
  // A test inside `packages/<name>/` or `internal/<name>/` covers the module
  // `<name>`; the pair is (test, the module's entry file). Module identity is
  // read from the SAME function the ranking already uses for locality, so the
  // pairing cannot disagree with it.
  const entryByModule = new Map()
  for (const row of prepared) {
    if (isTestFile(row.path)) continue
    const module = moduleOf(row.path)
    if (!module) continue
    const current = entryByModule.get(module)
    // The module's ENTRY FILE, not its alphabetically first file. A module is
    // published by the file named after it (`quay/quay.ts`) or by its barrel
    // (`index`, `mod`, `main`, `__init__`); "the first one that sorts" is neither,
    // and it decided which source a module-level test was demoted below.
    const rank = (file) => {
      const leaf = file.split("/").pop().toLowerCase()
      const stem = singular(fileStem(file))
      if (module.split("/").pop().toLowerCase() === stem) return 0
      if (DIRECTORY_ENTRY_STEMS.has(stem)) return 1
      return 2
    }
    if (!current) { entryByModule.set(module, row.path); continue }
    const better = rank(row.path) - rank(current)
    if (better < 0 || (better === 0 && row.path.localeCompare(current) < 0)) entryByModule.set(module, row.path)
  }
  const sourceOfTest = new Map()
  for (const row of prepared) {
    if (!isTestFile(row.path)) continue
    const stem = singular(fileStem(row.path))
    const module = moduleOf(row.path)
    // Same module first. `edge/test/selvedge.spec.ts` and `hem/src/selvedge.ts`
    // share a stem, and a single global stem map paired the test with whichever
    // module happened to be seen last -- which demoted the WRONG source and
    // promoted the other module's file to the lead.
    const inModule = sourceStemsByModule.get(module)?.get(stem)
    if (inModule) { sourceOfTest.set(row.path, inModule); continue }
    const byStem = sourceByStem.get(stem)
    if (byStem) { sourceOfTest.set(row.path, byStem); continue }
    const byModule = entryByModule.get(module)
    if (byModule && module.split("/").pop() && module.split("/").pop().toLowerCase() === stem) {
      sourceOfTest.set(row.path, byModule)
    }
  }

  // Intent comes from the query's own words, using the SAME vocabulary
  // `isTestFile` already applies -- not a second list, and not a comparison of
  // candidate weights. The first attempt compared raw structural weight sums,
  // which could never work: `exact-symbol` (100) always outranks
  // `path-basename` (45), so a test that matched the query's noun was always
  // judged "not a test query" and the ordering constraint fired on every
  // test-oriented query, pushing tests several ranks down. The defect was in the
  // intent test, not in the weights.
  const testIntent = hasExplicitTestIntent(lowerTerms)

  // Reasons that describe a file's POSITION in the dependency graph rather than
  // its content. They are what makes a file reachable, and they are not what
  // makes it the answer.
  const RELATIONSHIP_REASONS = new Set(["reverse-reference", "second-hop", "convergent-dependency"])

  // TEST COVERAGE EVIDENCE.
  //
  // A test file declares a test function whose name names the unit under test:
  // `test_sign_payload_is_stable`, `TestMarkIncreasesDepth`,
  // `testApplyTensionScales`. That declaration is the structural proof that
  // THIS test covers THAT subject -- and it is a declaration, not a mention, so
  // it is strong evidence.
  //
  // Without it the class had nowhere to go: the test file's own path rarely
  // matches the query's identifier (`test_forgeutil_signature.py` does not
  // contain "sign_payload"), so it scored as a mere mention and sat below the
  // source file it was written to cover. Ranking a mention below a definition is
  // right; ranking the file that PROVES coverage below the thing it covers is
  // answering a different question.
  const subjectTerms = analysis.exactIdentifiers
    .filter((item) => !item.isShapeWord && item.parts.length && !isTestVocabulary(item.term))
    .map((item) => item.parts)
  for (const row of prepared) {
    if (!isTestFile(row.path)) continue
    const entry = semantic.index?.files?.[row.path] || { symbols: [] }
    const covers = subjectTerms.filter((parts) =>
      (entry.symbols || []).some((symbol) => partsCover(identifierParts(String(symbol.name || "")).map(singular), parts)))
    if (!covers.length) continue
    row.coversSubject = covers.length
    row.reasons = [...new Set([...row.reasons, "test-covers-subject"])].sort()
    // Coverage is EVIDENCE, and it is labelled as such on every row. It only
    // becomes SCORE when the query actually asked about tests. Promoting a test
    // above the source it covers for a query that never mentioned a test is the
    // mirror image of the original defect: `test-requested` used to fire on any
    // test that matched the query's noun, which lifted `selvedge.spec.ts` to the
    // lead of "Selvedge Stitch getter".
    if (testIntent) {
      row.score += weightOf("testTarget")
      row.contributions = [
        ...row.contributions,
        { reason: "test-requested", weight: weightOf("testTarget"), points: weightOf("testTarget") },
      ]
      row.reasons = [...new Set([...row.reasons, "test-requested"])].sort()
    }
  }

  // ---- resolved query subject -----------------------------------------
  // Applied to the already-attributed rows, so it adds a contribution like any
  // other feature and cannot introduce an unattributed point.
  //
  // The resolution also answers a second question the ranking needs: is a test
  // file allowed to be the answer to this query at all? It is allowed when the
  // query named a test, or when the query named a PATH that resolves to a test
  // file. Otherwise a test may be ranked -- through its coverage evidence and
  // its relationships -- but it is never promoted as the subject.
  const subjectPath = resolveQuerySubject(prepared, analysis)
  const explicitPathIsTest = Boolean(subjectPath && isTestFile(subjectPath))
  const testSubjectAllowed = testIntent === true || explicitPathIsTest
  if (subjectPath) {
    const row = prepared.find((item) => item.path === subjectPath)
    if (row && !row.reasons.includes("explicit-path-target")) {
      const weight = weightOf("explicitPathTarget")
      row.score += weight
      row.contributions = [...row.contributions, { reason: "explicit-path-target", weight, points: weight }]
      row.reasons = [...new Set([...row.reasons, "explicit-path-target"])].sort()
      row.tier = REPO_MAP_TIER.TARGET
      row.resolvedSubject = true
    }
  }

  for (const row of prepared) {
    if (!isTestFile(row.path)) continue;
    if (testIntent) {
      // The query named a test, so the test is a first-class answer rather than a
      // neighbour of one. The promotion is earned by covering the query's own
      // subject. Promoting every test file in the workspace because the word
      // "test" appeared is how three unrelated specs reached the top three of
      // "test that applyTension scales" and pushed the real source file out.
      const aboutSubject = (row.coversSubject || 0) > 0
        || row.reasons.includes("exact-symbol")
        || row.reasons.includes("path-basename")
      if (!aboutSubject) continue
      if (row.reasons.includes("explicit-path-target")) continue
      if (row.reasons.includes("test-requested")) continue
      row.score += weightOf("testTarget")
      row.contributions = [
        ...row.contributions,
        { reason: "test-requested", weight: weightOf("testTarget"), points: weightOf("testTarget") },
      ]
      row.reasons = [...new Set([...row.reasons, "test-requested"])].sort()
    } else {
      // A test's RELATIONSHIP to the subject is evidence that the test exists,
      // not that it is the answer. When the query did not ask about tests, that
      // evidence is voided: `view.spec.ts` was reaching rank one of "studio
      // manifest calls the view" purely because it imports the view, which
      // pushed the file the question is actually about to third place.
      //
      // The contributions are REMOVED rather than reduced, so the published
      // score still equals the sum of the reasons published beside it.
      const keep = row.contributions.filter((item) => !RELATIONSHIP_REASONS.has(item.reason))
      if (keep.length !== row.contributions.length) {
        row.contributions = keep
        row.score = Number(keep.reduce((sum, item) => sum + Number(item.points || 0), 0).toFixed(6))
        row.reasons = row.reasons.filter((reason) => !RELATIONSHIP_REASONS.has(reason))
      }
      if (sourceOfTest.has(row.path)) {
        // No score penalty. The ordering constraint below expresses this rule
        // properly; penalising the score as well was double-counting it, and the
        // double count is what cost the test-lookup class its MRR.
        row.reasons = [...new Set([...row.reasons, "test-of-target"])].sort()
      }
    }
  }

  prepared.sort(stableCompare)

  // The constraint, applied ONCE, after sorting, and it can only ever DEMOTE.
  //
  // A test already ranked below its source keeps its exact position: dragging it
  // up to sit directly under the source would promote it past files that
  // genuinely scored higher, which is the opposite of what the rule is for.
  //
  // A test that LEADS its source is the only case that moves: the source is
  // emitted first and the test immediately after it. The first implementation
  // pushed the test and then spliced the source in behind it, which left the
  // test leading -- i.e. the constraint ran and did nothing, which is how a
  // pre-existing regression test caught it.
  //
  // It is skipped entirely when the query NAMED a test, or when the query named
  // a path that resolves to a test file: in both cases the test is the answer,
  // and demoting it would answer a question nobody asked.
  let ordered = prepared
  if (!testSubjectAllowed) {
    const position = new Map(prepared.map((row, index) => [row.path, index]))
    const reordered = []
    const placed = new Set()
    const emit = (row) => {
      if (!row || placed.has(row.path)) return;
      reordered.push(row);
      placed.add(row.path);
    }
    for (const row of prepared) {
      if (placed.has(row.path)) continue;
      const sourcePath = sourceOfTest.get(row.path)
      if (!sourcePath) { emit(row); continue }
      const sourceIndex = position.get(sourcePath)
      const testIndex = position.get(row.path)
      if (sourceIndex == null || testIndex == null || testIndex > sourceIndex) { emit(row); continue }
      // This test leads its source: source first, test second.
      emit(prepared[sourceIndex])
      emit(row)
    }
    // Anything still unplaced keeps its score order, after the constrained rows.
    for (const row of prepared) emit(row);
    ordered = reordered;
  }

  // ---- stage 4: budgeted selection -------------------------------------
  const budget = Math.max(400, Number(options.contextBudgetChars ?? limits.contextBudgetChars))
  const hardLimit = Math.max(1, Math.min(Number(options.limit ?? limits.limit), 64))
  const selected = []
  let contextChars = 0
  let dropped = 0
  for (const row of ordered) {
    if (selected.length >= hardLimit) { dropped += 1; continue }
    const cost = repoMapRowChars(row)
    if (contextChars + cost > budget && selected.length > 0) { dropped += 1; continue }
    selected.push({ ...row, chars: cost })
    contextChars += cost
  }

  // ---- optional LSP enrichment (bounded, top candidates only) -----------
  let lspEnriched = 0
  if (options.enrichLsp === true && typeof options.lsp === "function") {
    for (const row of selected.slice(0, Math.max(0, limits.maxEnrichedFiles))) {
      const enrichment = await options.lsp({ root, relative: row.path, terms }).catch(() => null)
      if (!enrichment) continue
      lspEnriched += 1
      const symbols = new Set(row.importantSymbols)
      for (const name of enrichment.relatedSymbols || []) symbols.add(String(name))
      row.importantSymbols = [...symbols].slice(0, limits.maxSymbolsPerFile)
      row.reasons = [...new Set([...row.reasons, "lsp-enriched"])].sort()
      row.relationship = {
        ...(row.relationship || {}),
        lsp: {
          references: Number(enrichment.references || 0),
          definitions: Number(enrichment.definitions || 0),
          available: true,
        },
      }
    }
  }

  return {
    schemaVersion: 1,
    kind: "ues-repo-map",
    root,
    query,
    terms,
    evidenceLevel: "semantic-symbol+dependency-graph",
    files: selected,
    stats: {
      candidateCount: rows.size,
      lexicalCandidates: candidateCount,
      selectedCount: selected.length,
      dropped,
      graphExpansionCount,
      contextBudgetChars: budget,
      contextChars,
      lspEnriched,
      affectedTests: (affected.tests || []).length,
      affectedTestsDegraded: affected.degraded === true,
      graphNodes: (graph.nodes || []).length,
      graphEdges: (graph.edges || []).length,
      semanticCacheHit: semantic.runtimeCacheHit === true,
      graphCacheHit: false,
      durationMs: Date.now() - started,
    },
  }
}

function normalizeMapFile(value) {
  const normalized = normalizeMapPath(value)
  return isWorkspaceRelativeMapPath(normalized) ? normalized : ""
}

function safeChangedFiles(root) {
  try {
    return gitChangedFiles(root)
  } catch {
    return []
  }
}

// Only verified memory may contribute, and only through the bounded bonus above.
// A superseded, expired or unverified record is ignored here rather than being
// filtered later, so it cannot reach the score at all.
//
// Memory also may not INTRODUCE a file. It can only nudge a file that the query
// already surfaced on independent evidence, which is the strongest form of the
// "never override direct code evidence" rule: a remembered opinion cannot put a
// file on the map that the code did not already justify.
function verifiedMemoryAffinity(options) {
  const rows = options.verifiedMemoryRows
  if (!Array.isArray(rows) || !rows.length) return new Map()
  const map = new Map()
  for (const row of rows) {
    if (row?.verified !== true) continue
    if (row?.superseded === true || row?.expired === true) continue
    const file = normalizeMapPath(row.file || row.path)
    if (!file) continue
    const confidence = Math.max(0, Math.min(1, Number(row.confidence ?? 0)))
    map.set(file, Math.max(map.get(file) || 0, confidence))
  }
  return map
}

function describeRelationship(row, nodeByPath, incoming, anchors) {
  const node = nodeByPath.get(row.path)
  const direct = (node?.localImports || []).filter((item) => anchors.includes(item)).slice(0, 4)
  const referencedBy = (incoming.get(row.path) || []).filter((item) => anchors.includes(item)).slice(0, 4)
  if (!direct.length && !referencedBy.length && !row.reasons.has("changed-file") && !row.reasons.has("declared")) {
    return null
  }
  return {
    importsFromAnchor: direct,
    referencedByAnchor: referencedBy,
    kind: row.reasons.has("declared") ? "declared"
      : row.reasons.has("changed-file") ? "changed"
        : direct.length ? "dependency" : referencedBy.length ? "dependent" : "related",
  }
}

// The unique file the query is about.
//
// Two of the ten retrieval classes cannot be answered by "which file declares
// the queried symbol", because the queried symbol is not the subject:
//
//   "seal_vault used to build a rollup"  -> report.py DECLARES the rollup and
//                                           only REFERENCES seal_vault
//   "weaveCloth used to build a legend"  -> legend.ts DECLARES the legend and
//                                           only REFERENCES weaveCloth
//   "how does weaving a cloth combine warp and weft" -> weaveCloth's words span
//                                           the subject; warpThread's do not
//
// All three share one structural fact: exactly ONE declaration covers several of
// the query's own content words. The resolution rule is therefore stated once,
// in terms of evidence, with no model and no vocabulary:
//
//   1. an EXPLICIT PATH in the query that resolves to exactly one candidate is
//      the subject -- strongest, because the query named a location;
//   2. under DEFINITION intent ("where is X defined"), the file that DEFINES the
//      queried identifier is the subject;
//   3. otherwise the file whose declaration covers the MOST distinct query
//      content words is the subject, and only if that maximum is >= 2 and
//      UNIQUE.
//
// A tie produces no subject at all. That is deliberate: when two files cover
// the query equally well, the query is genuinely ambiguous and the ranking must
// fall back on the evidence ladder instead of inventing an answer.
//
// A TEST FILE IS NOT A CANDIDATE FOR THE SUBJECT unless the query asked about
// tests, or the query named a path that resolves to it. `pricing.test.mjs` names
// the subject because its test function is named after it -- that is evidence
// ABOUT the subject, not an alternative subject -- and the previous version of
// this function fell back to a test-only pool whenever no production file
// reached the coverage threshold. That fallback is what let a test become the
// first row of a query that never mentioned a test. Tests are not demoted: they
// are still scored, still published with their coverage evidence, and still
// demoted below their source by the ordering constraint.
function resolveQuerySubject(candidates, analysis) {
  const explicit = resolveExplicitPathSubject(candidates, analysis)
  if (explicit) return explicit
  const definitionIntent = analysis?.definitionIntent === true
  const testIntent = analysis?.testIntent === true
  const pool0 = testIntent
    ? candidates
    : candidates.filter((row) => !isTestFile(row.path))
  if (definitionIntent) {
    const definers = pool0.filter((row) => (row.reasons || []).includes("exact-symbol"))
    if (definers.length === 1) return definers[0].path
  }
  // EXPLICIT TEST INTENT OVERRIDES THE EXCLUSION. When the query asked about
  // tests, a test declaration is precisely the evidence that matters, so the
  // unrestricted coverage is read; when it did not, the restricted coverage that
  // ignores test declarations is read and test files are out of the pool.
  const coverageOf = testIntent
    ? (row) => Number(row.derivedCoverage || 0)
    : (row) => Number(row.subjectCoverage || 0)
  const rankBy = (pool) => pool
    .filter((row) => coverageOf(row) >= 2)
    .sort((a, b) => coverageOf(b) - coverageOf(a) || a.path.localeCompare(b.path))
  const pool = rankBy(pool0)
  if (!pool.length) return null
  const best = pool[0]
  if (pool[1] && coverageOf(pool[1]) === coverageOf(best)) return null
  return best.path
}

// An explicit path in the query that resolves to exactly ONE candidate.
//
// "exact path" and "unique directory prefix" are the two shapes a person can
// type; both name one location. A directory prefix shared by several candidates
// (`modules/quay` holding five files) is locality evidence -- it is already
// graded `path-prefix` -- and is deliberately NOT a subject here, because the
// question "which file?" has not been answered by naming the directory.
function resolveExplicitPathSubject(candidates, analysis) {
  const pathTerms = (analysis?.terms || [])
    .filter((item) => item.source === QUERY_TERM_SOURCE.PATH_TOKEN)
    .map((item) => normalizeMapPath(item.term))
    .filter((term) => term && isUsableRelativePath(term) && term.split("/").length >= 2)
  if (!pathTerms.length) return null
  for (const term of pathTerms) {
    const normalized = normalizeMapPath(term).toLowerCase()
    const exact = candidates.filter((row) => row.path.toLowerCase() === normalized)
    if (exact.length === 1) return exact[0].path
    const prefixed = candidates.filter((row) => row.path.toLowerCase().startsWith(normalized + "/"))
    if (prefixed.length === 1) return prefixed[0].path
  }
  return null
}

export const repoMapRuntimeExports = Object.freeze({
  buildRepoMap,
  clearRepoMapRuntimeCache,
  queryTerms,
  repoMapRowChars,
  REPO_MAP_WEIGHTS,
  REPO_MAP_TIER,
})
