// Path and module identity for retrieval ranking (V15.3 structural repair).
//
// WHAT THIS IS FOR
//
// Two of the defects this file exists to prevent are the SAME defect seen from
// two directions:
//
//   HB-D2  a query term that names a MODULE ("dockyard Registry") cannot break a
//          same-symbol tie, because nothing knows what "dockyard" is.
//   HB-D3  a query term that names a PATH ("modules/quay") is graded by matching
//          each directory segment independently, so the shared parent
//          "modules" credits a candidate in modules/dockyard as well.
//
// The fix is one thing, stated once: a module is a DECLARED boundary, and a
// path is a HIERARCHY. Neither may be approximated by an arbitrary ancestor
// directory name.
//
// WHAT COUNTS AS A MODULE BOUNDARY
//
// Every rule below is backed by a declaration that exists in the repository:
//
//   npm-package     a directory containing package.json, identified by its
//                   declared `name` when it has one
//   go-module       a directory containing go.mod, identified by its `module`
//                   prefix
//   go-package      a directory whose Go files declare `package X`
//   python-package  a directory containing __init__.py
//   workspace-member a directory matched by a root manifest's `workspaces` glob
//   source-root     a stable source directory: src, lib, libs, internal, pkg,
//                   cmd, modules, services, packages, apps
//   container-child the immediate children of a CONTAINER -- a directory that
//                   holds no source file of its own and at least two child
//                   directories, i.e. a directory whose only job is to group
//                   other directories
//
// The last rule is what makes `modules/dockyard` and `forge/forgeutil` module
// boundaries without hard-coding either name, and it is deliberately narrow: a
// directory that holds files is not a container, so `specs/` (which holds the
// tests) is not one, and no identity is ever invented from a directory name
// that merely happens to be an ancestor.
//
// WHAT A PATH MATCH IS WORTH
//
// Path evidence is graded by how much of the path the query actually named:
//
//   path-exact       the query named this exact file path
//   path-prefix      the query named a directory that contains this file
//   path-module-root the query named this file's declared module root
//   path-basename    the query named this file's stem
//   path-segment     ONE segment of a single-segment query word equals one
//                    directory name -- a bounded weak fallback
//   path-partial     the token occurs somewhere in the path
//
// The per-segment grade exists only for single-segment query words. A token
// with two or more segments names ONE location, and matching any one of its
// segments against a directory is exactly how "modules/quay" ended up
// crediting "modules/dockyard".

export const SOURCE_ROOT_SEGMENTS = new Set([
  "src", "lib", "libs", "internal", "pkg", "cmd", "modules", "services", "packages", "apps",
])

export const MODULE_ROOT_KINDS = Object.freeze([
  "npm-package",
  "go-module",
  "go-package",
  "python-package",
  "workspace-member",
  "source-root",
  "container-child",
])

/** Normalise separators and strip a leading `./`, without resolving `..`. */
export function normalizeRelativePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").trim()
}

/**
 * A path token or file path is usable only if it stays inside the workspace and
 * names something. A traversal, an absolute path and a drive letter are refused
 * rather than cleaned: cleaning a traversal is how a query becomes a read
 * outside the workspace.
 */
export function isUsableRelativePath(value) {
  const normalized = normalizeRelativePath(value)
  if (!normalized) return false
  if (normalized.startsWith("/")) return false
  if (normalized.startsWith("~")) return false
  if (normalized.startsWith("//")) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  return !normalized.split("/").some((segment) => segment === "..")
}

function directoryOf(relative) {
  const normalized = normalizeRelativePath(relative)
  const cut = normalized.lastIndexOf("/")
  return cut < 0 ? "" : normalized.slice(0, cut)
}

function leafOf(relative) {
  const normalized = normalizeRelativePath(relative)
  const cut = normalized.lastIndexOf("/")
  return cut < 0 ? normalized : normalized.slice(cut + 1)
}

// Directories whose NAME is structure, not identity.
//
// `packages/spool/src` and `packages/spool/test` are the inside of a module, not
// modules of their own. Treating them as modules moved a test out of the module
// it covers -- the test then had no source to be ranked below -- and invented a
// module called "test" that any query word could bind to.
export const STRUCTURAL_DIRECTORY_NAMES = new Set([
  "src", "lib", "libs", "bin", "dist", "build", "out", "target", "obj",
  "test", "tests", "__tests__", "__test__", "spec", "specs", "testing", "unittests", "integration",
  "internal", "cmd", "pkg", "app", "apps", "packages", "modules", "services",
  "docs", "doc", "examples", "example", "generated", "migrations", "assets",
  "static", "public", "resources", "config", "vendor", "third_party",
])

/** Every directory prefix of every indexed directory, longest first. Derived from
 * the indexed files, so it costs one pass and cannot disagree with the file set.
 */
export function collectDirectories(directoryEntries) {
  const dirs = new Set()
  for (const directory of directoryEntries) {
    const normalized = normalizeRelativePath(directory)
    if (!normalized || normalized === ".") continue
    const parts = normalized.split("/")
    for (let index = 1; index <= parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"))
  }
  return dirs
}

/**
 * Directories whose only content is other directories. These are the grouping
 * directories of a tree -- `modules`, `apps`, `forge` -- and their immediate
 * children are the module boundaries the tree is actually made of.
 *
 * A directory that holds at least one source file is never a container, which
 * is what keeps a `specs/` or `test/` directory from being read as a group.
 *
 * @param {{directories?: Set<string>|string[], directoryFiles?: Map<string, unknown[]>, minChildren?: number}} options
 * @returns {Set<string>}
 */
export function containerDirectories(options = {}) {
  const { directories, directoryFiles, minChildren = 2 } = options
  const dirs = directories || new Set()
  const containers = new Set()
  const needed = Math.max(2, Number(minChildren) || 2)
  for (const directory of dirs) {
    if ((directoryFiles?.get?.(directory) || []).length > 0) continue
    // CHILD directories, not siblings. `layers/` is a container because it holds
    // `layers/harbour`, `layers/berthside` and `layers/shared`; counting the
    // directories that sit NEXT TO `layers` measured a completely different
    // property, and a grouping directory with one sibling was never recognised.
    const children = [...dirs].filter((candidate) => directoryOf(candidate) === directory)
    if (children.length >= needed) containers.add(directory)
  }
  return containers
}

/**
 * A module resolver: file path -> declared module identity.
 *
 * `roots` is the list of declared boundaries produced by the dependency graph.
 * The resolver is a pure lookup over that list, sorted longest-first so the
 * DEEPEST boundary wins, which is what makes `packages/spool/src` fall back to
 * `packages/spool` rather than to the repository root.
 *
 * @param {Array<{dir: string, identity: string, kind: string}>} roots
 */
export function createModuleResolver(roots = []) {
  const sorted = [...roots]
    .filter((root) => root && isUsableRelativePath(root.dir))
    .map((root) => ({ ...root, dir: normalizeRelativePath(root.dir) }))
    .sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir))
  const identityByDir = new Map(sorted.map((root) => [root.dir, root]))
  const identities = new Set()
  for (const root of sorted) for (const token of identityTokens(root)) identities.add(token)
  // Both lookups below run once per (candidate, query term) pair, so both are
  // memoised per file / per boundary. Path grading is on the per-query hot path
  // and an unmemoised linear scan per term is what made the map measurably more
  // expensive than the ranking it replaced.
  const rootCache = new Map()
  const identityCache = new Map()
  // The deepest declared boundary containing `file`, or null. Longest-first
  // ordering is the whole implementation: `packages/spool/src` therefore falls
  // back to `packages/spool` rather than to the repository root.
  const rootFor = (file) => {
    const normalized = normalizeRelativePath(file)
    if (rootCache.has(normalized)) return rootCache.get(normalized)
    let found = null
    for (const root of sorted) {
      if (root.dir === "") continue
      if (normalized === root.dir || normalized.startsWith(root.dir + "/")) { found = root; break }
    }
    rootCache.set(normalized, found)
    return found
  }
  return {
    roots: sorted,
    identities,
    identityByDir,
    rootFor,
    /** Every word that names this boundary, memoised. */
    identitiesFor(root) {
      const key = root?.dir ?? ""
      if (identityCache.has(key)) return identityCache.get(key)
      const set = new Set(root ? identityTokens(root) : [])
      identityCache.set(key, set)
      return set
    },
    /** Stable module key: the declared boundary, else the containing directory. */
    moduleOf(file) {
      const normalized = normalizeRelativePath(file)
      const root = rootFor(normalized)
      return root ? root.dir : directoryOf(normalized)
    },
  }
}

/** Every word that names this module: its declared name, and its directory leaf. */
export function identityTokens(root) {
  const tokens = new Set()
  const identity = String(root?.identity || "").trim()
  if (identity) {
    tokens.add(identity.toLowerCase())
    const leaf = identity.includes("/") ? leafOf(identity) : identity
    if (leaf) tokens.add(leaf.toLowerCase())
    for (const segment of identity.toLowerCase().split("/")) {
      if (segment && !segment.startsWith("@")) tokens.add(segment)
    }
  }
  const leaf = leafOf(String(root?.dir || ""))
  if (leaf) tokens.add(leaf.toLowerCase())
  return [...tokens].filter(Boolean)
}

/**
 * Hierarchical path grading for ONE file against ONE query token.
 *
 * Returns the strongest grade the token earns, plus the term it was earned on,
 * so every point on a row can be traced back to the query text that produced it.
 *
 * `helpers` supplies the name predicates so this file does not have to depend
 * on the ranking's tokenizer: { matchesName(term, segment), stemOf(file),
 * isTestMarker(word) }.
 */
export function gradePathToken({ file, token, tokenSegments, resolver, helpers }) {
  const normalized = normalizeRelativePath(file)
  const lowerToken = normalizeRelativePath(token).toLowerCase()
  if (!lowerToken || !isUsableRelativePath(token)) return null
  const minLength = Math.max(1, Number(helpers?.minLength ?? 3))

  // 1. The query named this exact file path. A literal, unambiguous location:
  //    there is nothing weaker this could have meant.
  if (lowerToken === normalized.toLowerCase()) {
    return { grade: "path-exact", term: token, depth: normalized.split("/").length }
  }

  // Every grade below is a comparison of the token against something it might
  // only resemble, so every grade inherits the same minimum length. A two-letter
  // fragment matches too much to be evidence: "or" occurs inside almost every
  // file name, and grading it attached `path-partial` to unrelated files.
  if (lowerToken.length < minLength) return null

  const segments = tokenSegments.length ? tokenSegments : lowerToken.split("/").filter(Boolean)

  // 2. The query named a directory that contains this file. This is the module
  //    question, answered by the hierarchy rather than by a segment match.
  if (segments.length >= 2 && normalized.toLowerCase().startsWith(lowerToken + "/")) {
    return { grade: "path-prefix", term: token, depth: segments.length }
  }

  // 3. The query named the file's DECLARED module root, by any of its identities.
  const root = resolver?.rootFor?.(normalized)
  if (root) {
    const rootTokens = resolver?.identitiesFor ? resolver.identitiesFor(root) : new Set(identityTokens(root))
    const leaf = leafOf(root.dir).toLowerCase()
    if (lowerToken === root.dir.toLowerCase() || rootTokens.has(lowerToken) || lowerToken === leaf) {
      return { grade: "path-module-root", term: token, depth: root.dir.split("/").length }
    }
  }

  // 4. The query named this file's stem.
  const tokenStem = helpers?.stemOf?.(leafOf(lowerToken)) || ""
  const fileStem = helpers?.stemOf?.(leafOf(normalized)) || ""
  if (tokenStem.length >= 3 && tokenStem === fileStem) {
    return { grade: "path-basename", term: token, depth: 0 }
  }

  // 5. Bounded segment match. A single-segment query word may match one
  //    directory name. A MULTI-segment token may not: it names one location, and
  //    matching its parent segment is how a shared prefix became a false match.
  if (segments.length === 1 && helpers?.matchesName) {
    const directories = normalized.split("/").slice(0, -1)
    if (directories.some((segment) => helpers.matchesName(segments[0], segment))) {
      return { grade: "path-segment", term: token, depth: directories.length }
    }
  }

  // 6. Last resort: the token occurs somewhere in the path, with test markers
  //    stripped so the word "test" cannot match a test file's own name.
  const markerStripped = normalized.split("/").slice(0, -1).concat(fileStem).join("/").toLowerCase()
  if (markerStripped.includes(lowerToken)) return { grade: "path-partial", term: token, depth: 0 }
  return null
}

export const moduleIdentityRuntimeExports = Object.freeze({
  collectDirectories,
  containerDirectories,
  createModuleResolver,
  gradePathToken,
  identityTokens,
  isUsableRelativePath,
  normalizeRelativePath,
  MODULE_ROOT_KINDS,
  SOURCE_ROOT_SEGMENTS,
})
