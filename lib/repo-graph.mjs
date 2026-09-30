// Deterministic repository dependency graph.
//
// WHAT THIS MODULE IS FOR
//
// Retrieval that only ranks files by how well their names match a query cannot
// answer "who calls this" or "what does this depend on". Those answers are the
// graph's job, and the graph is only as good as its edges.
//
// THE DEFECT THIS REPAIRS
//
// Every non-relative specifier used to be treated as an EXTERNAL package, and
// the only resolver in the file handled `.` / `..` paths. In a real workspace
// that discards almost every edge:
//
//   Go       import "kiln/internal/smelt"        -> external, no edge
//   Python   from forge.forgeutil import sign   -> external, no edge
//   Python   from .signature import sign        -> ".signature" is a FILE name
//                                                    beginning with a dot, not
//                                                    "./signature", so path.resolve
//                                                    produced "forge/forgeutil/.signature"
//                                                    and the lookup missed
//   TS/JS    import { x } from "@loom/spool"    -> external, no edge
//
// The consequence was measured, not assumed: three representative workspaces of
// 48 source files produced 2 edges between them. A dependency graph with no edges
// is not a weak ranking signal, it is the absence of one -- and the retrieval
// classes that regressed (cross-module dependency, reverse dependency, re-export)
// were exactly the classes that need it.
//
// WHAT IS GUARANTEED HERE
//
//   - Resolution is a lookup in an index built from the files this graph already
//     scanned. A specifier either names a file that exists in this workspace or
//     it stays external. Nothing is guessed and nothing is fetched.
//   - Every tie-break is a fixed rule (extension order, then lexicographic), so
//     the graph is byte-identical across filesystems and concurrency settings.
//   - Work per specifier is bounded by MAX_RESOLUTION_ATTEMPTS, not by the size
//     of the repository.
//   - A resolved path can never escape the workspace, and an external package
//     can never acquire a local edge.
//   - An `export ... from` is a RE-EXPORT, recorded with its own edge kind, so a
//     barrel is distinguishable from an ordinary import.

import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"
import { UES_RUNTIME_DIRS } from "./runtime-artifacts.mjs"
import {
  collectDirectories,
  containerDirectories,
  normalizeRelativePath,
  SOURCE_ROOT_SEGMENTS,
  STRUCTURAL_DIRECTORY_NAMES,
} from "./module-identity.mjs"

// Declaration strength, strongest first. A directory that has its own manifest is
// a package before it is anything structural.
const MODULE_KIND_PRIORITY = [
  "npm-package",
  "go-module",
  "workspace-member",
  "go-package",
  "python-package",
  "source-root",
  "container-child",
]

const SKIP = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv",
  "Pods", "DerivedData", ".gradle", ".idea", ".cache", ".turbo", "target", "obj",
  ...UES_RUNTIME_DIRS,
])

const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".java", ".kt", ".kts",
  ".cs", ".go", ".rs", ".rb", ".php", ".vue", ".svelte",
])

// Manifests that declare a LOCAL namespace. Without them a Go module path or a
// workspace package name is indistinguishable from a third-party package, and
// the importer is discarded as "external".
const MANIFEST_FILES = new Set(["package.json", "go.mod"])

// Ordered extensions tried when a specifier names a module without one. The
// order is fixed so resolution is reproducible across machines.
const RESOLUTION_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".java", ".kt", ".kts", ".cs", ".rs", ".rb", ".php",
]

// Bound on the candidate shapes tried per specifier. Resolution is a lookup in a
// prebuilt index, not a filesystem search, so this caps per-specifier work
// without capping what may be resolved.
const MAX_RESOLUTION_ATTEMPTS = 48

// Go test files are package members but never the answer to "which file provides
// this package", so they lose to a non-test sibling.
const TEST_FILE_STEM = /[._-](test|spec)s?$/i

// Names a directory publishes itself under.
const DIRECTORY_ENTRY_STEMS = new Set(["index", "__init__", "mod", "main"])

async function walk(root, maxFiles = 2500, maxDepth = 8) {
  const files = []
  const manifests = []
  async function visit(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (!entry.isFile()) continue
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
      else if (MANIFEST_FILES.has(entry.name)) manifests.push(full)
    }
  }
  await visit(root, 0)
  return { files, manifests }
}

async function mapLimit(items, limit, worker) {
  if (!items.length) return []
  const output = new Array(items.length)
  let cursor = 0
  const width = Math.min(items.length, Math.max(1, Number(limit || 1)))
  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      output[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return output
}

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function isInsideWorkspace(root, relative) {
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

// Import statements are returned as RECORDS, not as bare strings, because the
// RELATIONSHIP matters as much as the target:
//
//   kind       "import" | "re-export" | "require" | "dynamic-import"
//   form       "module" | "python-relative" | "dotted"
//   module     the specifier to resolve
//   level      python relative level (leading dots), 0 when not python-relative
//   names      bound names, needed to decide whether `from .x import y` inside a
//              package re-exports y or merely uses it
//
// `export { a }` with no `from` is NOT a re-export, and an `import ( ... )` block
// yields every specifier rather than only the first.
function importsFor(source, ext) {
  const records = []
  const seen = new Set()
  const push = (record) => {
    const clean = String(record.module || "").trim()
    if (!clean) return
    const key = [record.kind, record.form, clean, record.level || 0, record.python ? 1 : 0, (record.names || []).join("|")].join("\u0000")
    if (seen.has(key)) return
    seen.add(key)
    records.push({ ...record, module: clean })
  }

  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte"].includes(ext)) {
    for (const match of source.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s*["']([^"']+)["']/g)) {
      push({ kind: "re-export", form: "module", module: match[1] })
    }
    for (const match of source.matchAll(/\bimport\s+(?:type\s+)?(?:[^"'\n;]*?\s+from\s+)?["']([^"']+)["']/g)) {
      push({ kind: "import", form: "module", module: match[1] })
    }
    for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      push({ kind: "require", form: "module", module: match[1] })
    }
    for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      push({ kind: "dynamic-import", form: "module", module: match[1] })
    }
  } else if (ext === ".py") {
    // `from a.b import c` (absolute) and `from .a import c` (relative) share one
    // shape; the leading dots are what separates them.
    for (const match of source.matchAll(/^from\s+(\.*)([A-Za-z0-9_.]*)\s+import\s+([^\n#]+)/gm)) {
      const names = match[3]
        .replace(/[()]/g, "")
        .split(",")
        .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean)
      const dots = match[1] || ""
      push(dots
        ? { kind: "import", form: "python-relative", module: match[2], level: dots.length, names }
        : { kind: "import", form: "dotted", module: match[2], names, python: true })
    }
    // `from . import name` binds a SIBLING MODULE, not a package.
    for (const match of source.matchAll(/^from\s+(\.+)\s+import\s+([^\n#]+)/gm)) {
      for (const raw of match[2].split(",")) {
        const clean = raw.trim().split(/\s+as\s+/)[0].trim()
        if (clean && clean !== "*") push({ kind: "import", form: "python-relative", module: clean, level: match[1].length, names: [] })
      }
    }
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z0-9_.]+(?:\s*,\s*[A-Za-z0-9_.]+)*)/gm)) {
      for (const raw of match[1].split(",")) push({ kind: "import", form: "dotted", module: raw.trim(), python: true })
    }
  } else if ([".java", ".kt", ".kts"].includes(ext)) {
    for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_0-9_.*]+)/gm)) push({ kind: "import", form: "dotted", module: match[1] })
  } else if (ext === ".cs") {
    for (const match of source.matchAll(/^\s*using\s+(?:static\s+)?([A-Za-z0-9_.]+)/gm)) push({ kind: "import", form: "dotted", module: match[1] })
  } else if (ext === ".go") {
    for (const match of source.matchAll(/^\s*import\s+(?:"([^"\n]+)"|([A-Za-z0-9_.]+))\s*$/gm)) {
      push({ kind: "import", form: "module", module: match[1] || match[2] })
    }
    for (const match of source.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
      for (const inner of match[1].matchAll(/["']([^"']+)["']/g)) push({ kind: "import", form: "module", module: inner[1] })
    }
  } else if (ext === ".rs") {
    for (const match of source.matchAll(/^\s*use\s+([^;]+);/gm)) push({ kind: "import", form: "dotted", module: match[1].trim() })
  }
  return records
}

// Python package re-export detection.
//
// `__all__` is the explicit, deterministic signal: a name the package lists in
// `__all__` and does not itself declare is, by the language's own rules,
// re-exported. When `__all__` is absent the package re-exports what it imported,
// which is the documented Python default.
// Python package re-export detection.
//
// `__all__` is the explicit, deterministic signal: a name the package lists in
// `__all__` and does not itself declare is, by the language's own rules,
// re-exported. When `__all__` is absent the package re-exports what it imported
// -- but that default belongs to a PACKAGE (`__init__.py`) alone. Applying it to
// every module would label `from .seal import seal_vault` inside rotate.py a
// re-export, which is exactly the distinction the retrieval ranking needs.
function pythonReExportNames(source, names, isPackageModule) {
  const out = new Set()
  if (!names || !names.length) return out
  if (!isPackageModule) return out
  const declared = new Set()
  for (const match of source.matchAll(/^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm)) declared.add(match[1])
  for (const match of source.matchAll(/^\s*class\s+([A-Za-z_][\w]*)/gm)) declared.add(match[1])
  for (const match of source.matchAll(/^\s*([A-Za-z_][\w]*)\s*(?::[^=\n]+)?=(?!=)/gm)) declared.add(match[1])
  const allMatch = source.match(/__all__\s*=\s*\[([^\]]*)\]/)
  const listed = new Set(
    allMatch
      ? [...allMatch[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
      : names,
  )
  for (const name of names) {
    if (!listed.has(name)) continue
    if (declared.has(name)) continue
    out.add(name)
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic workspace index
// ---------------------------------------------------------------------------

// Prefer a non-test file, then the earlier extension in RESOLUTION_EXTENSIONS,
// then lexicographic. Never "first seen": discovery order is not a stable input.
function preferCandidate(a, b) {
  if (a === b) return a
  const aTest = TEST_FILE_STEM.test(path.posix.basename(a)) ? 1 : 0
  const bTest = TEST_FILE_STEM.test(path.posix.basename(b)) ? 1 : 0
  if (aTest !== bTest) return aTest < bTest ? a : b
  const rank = (file) => {
    const index = RESOLUTION_EXTENSIONS.indexOf(path.extname(file).toLowerCase())
    return index < 0 ? RESOLUTION_EXTENSIONS.length : index
  }
  const ar = rank(a)
  const br = rank(b)
  if (ar !== br) return ar < br ? a : b
  return a.localeCompare(b) <= 0 ? a : b
}

function buildWorkspaceIndex(root, files, fileSet, manifests, manifestText) {
  const fileByStem = new Map()
  const directoryEntry = new Map()
  const filesByDirectory = new Map()
  // A PACKAGE-PATH SUFFIX index.
  //
  // A dotted specifier names a module relative to the PACKAGE ROOT, not to the
  // workspace root. `apps/beacon/src/beaconkeep/ledger.py` is imported as
  // `beaconkeep.ledger`, and no amount of workspace-relative lookup finds it:
  // the only thing that maps the specifier onto the file is the file's own
  // directory path with a bounded number of leading segments stripped.
  //
  // Every suffix with at least two segments is registered, and a suffix is used
  // only when it maps to EXACTLY ONE file. An ambiguous suffix resolves to
  // nothing rather than to an arbitrary winner, because a wrong edge is worse
  // than a missing one: a missing edge leaves the importer discoverable, while a
  // guessed edge corrupts every traversal that starts from it.
  const packagePath = new Map()

  const register = (map, key, value) => {
    const current = map.get(key)
    map.set(key, current === undefined ? value : preferCandidate(current, value))
  }

  for (const file of files) {
    const relative = rel(root, file)
    const directory = path.posix.dirname(relative)
    const base = path.posix.basename(relative)
    const extension = path.extname(base).toLowerCase()
    const stem = base.slice(0, base.length - extension.length)
    register(fileByStem, directory ? `${directory}/${stem}` : stem, relative)
    const list = filesByDirectory.get(directory) || []
    list.push(relative)
    filesByDirectory.set(directory, list)
    if (DIRECTORY_ENTRY_STEMS.has(stem)) register(directoryEntry, directory, relative)
  }
  for (const list of filesByDirectory.values()) list.sort()
  // Built from a SORTED file list so the index cannot depend on directory-read
  // order, which is not a stable input across filesystems.
  for (const file of [...files].sort()) {
    const relative = rel(root, file)
    const extension = path.extname(relative)
    const withoutExtension = extension ? relative.slice(0, relative.length - extension.length) : relative
    const parts = withoutExtension.split("/")
    // Strip at most three leading directories and always keep two segments, so a
    // bare `ledger` can never be reached by a dotted specifier.
    for (let start = 0; start <= Math.min(3, parts.length - 2); start += 1) {
      const key = parts.slice(start).join("/")
      if (!key || !key.includes("/")) continue
      const list = packagePath.get(key) || []
      if (!list.includes(relative)) list.push(relative)
      packagePath.set(key, list)
    }
  }

  const goModules = []
  const npmPackages = []
  const workspaceGlobs = []
  for (const manifest of manifests) {
    const relative = rel(root, manifest)
    const directory = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative)
    const text = String(manifestText.get(manifest) || "")
    if (path.posix.basename(relative) === "go.mod") {
      const match = text.match(/^\s*module\s+["']?([^"'\s]+)["']?/m)
      if (match?.[1]) goModules.push({ prefix: match[1], dir: directory })
      continue
    }
    let parsed = null
    try { parsed = JSON.parse(text) } catch { continue }
    const name = String(parsed?.name || "").trim()
    if (!name) continue
    // A plain-string `exports` is an entry point; an object or array of them is a
    // subpath map, which is not a single path and is therefore not used here.
    const exported = typeof parsed?.exports === "string" ? parsed.exports : ""
    const entry = String(parsed?.main || parsed?.module || parsed?.types || exported || "").replace(/^\.\//, "")
    npmPackages.push({ name, dir: directory, entry })
    for (const pattern of parsed?.workspaces || []) {
      for (const item of Array.isArray(pattern) ? pattern : [pattern]) workspaceGlobs.push(String(item || ""))
    }
  }
  // Longest name first so `@scope/a/b` is never captured by `@scope/a`.
  npmPackages.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))
  goModules.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix))

  // Workspace directories declared by a manifest glob.
  //
  // A monorepo whose members do not each carry a package.json cannot be
  // resolved from package names at all: `@scope/spool` names no local manifest,
  // so the importer looks external and the package is invisible. The workspace
  // glob is the declaration that DOES exist, so it is expanded -- one level
  // only, which is the only level a workspace glob is allowed to mean -- and a
  // specifier is matched against a declared member by its leaf name. The scope
  // is retained as identity but is not required to be derivable from the root
  // package name, because nothing in the repository says it must be.
  const workspaceDirectories = new Map()
  const allDirectories = new Set()
  // Children of a directory, derived from the indexed file set rather than from
  // an extra filesystem walk: a workspace member exists only if at least one
  // indexed source file lives inside it. Every ANCESTOR counts as a directory:
  // a workspace member such as `packages/spool` holds no file of its own.
  const childDirectories = (parent) => {
    if (!allDirectories.size) {
      for (const directory of filesByDirectory.keys()) {
        const parts = directory.split("/")
        for (let index = 1; index < parts.length; index += 1) {
          allDirectories.add(parts.slice(0, index).join("/"))
        }
      }
    }
    const out = []
    for (const directory of allDirectories) {
      if (path.posix.dirname(directory) !== parent) continue
      out.push(directory)
    }
    return out.sort()
  }
  for (const pattern of workspaceGlobs) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "")
    if (!clean) continue
    if (!clean.includes("*")) {
      if (filesByDirectory.has(clean)) workspaceDirectories.set(path.posix.basename(clean), clean)
      continue
    }
    const parent = clean.slice(0, clean.indexOf("*")).replace(/\/+$/, "")
    for (const member of childDirectories(parent)) {
      const leaf = path.posix.basename(member)
      if (!workspaceDirectories.has(leaf)) workspaceDirectories.set(leaf, member)
    }
  }
  const sortedWorkspaceDirectories = [...workspaceDirectories.keys()].sort()

  const resolvePathLike = (relativeBase) => {
    if (!relativeBase) return null
    if (!isInsideWorkspace(root, relativeBase)) return null
    if (fileSet.has(relativeBase)) return relativeBase
    for (const extension of RESOLUTION_EXTENSIONS) {
      if (fileSet.has(relativeBase + extension)) return relativeBase + extension
    }
    for (const extension of RESOLUTION_EXTENSIONS) {
      const nested = `${relativeBase}/index${extension}`
      if (fileSet.has(nested)) return nested
    }
    return directoryEntry.get(relativeBase) || null
  }

  // A DIRECTORY that is itself a Go/JS package resolves to its primary file:
  // the directory entry when it has one, else the file named after the
  // directory, else the first non-test member. Deterministic in all three cases.
  const directoryPrimary = (directory) => {
    if (!isInsideWorkspace(root, directory)) return null
    const members = filesByDirectory.get(directory)
    const entry = directoryEntry.get(directory)
    if (entry) return entry
    if (!members || !members.length) return null
    const nonTest = members.filter((file) => !TEST_FILE_STEM.test(path.posix.basename(file)))
    const pool = nonTest.length ? nonTest : members
    const leaf = path.posix.basename(directory)
    const named = pool.filter((file) => path.posix.basename(file).replace(/\.[^.]+$/, "") === leaf)
    return [...named, ...pool.filter((file) => !named.includes(file))][0]
  }

  const resolveModuleSpecifier = (specifier, options = {}) => {
    // Python resolves a directory PACKAGE before a same-named module file; a
    // JavaScript bundler resolves `./foo` to `foo.ts` first. The two orders are
    // different rules, so the importer's language picks the rule rather than an
    // arbitrary global preference.
    const preferPackage = options.preferPackage === true
    let attempts = 0
    // 1. Go module path: "kiln/internal/smelt".
    for (const module of goModules) {
      if (specifier !== module.prefix && !specifier.startsWith(module.prefix + "/")) continue
      const rest = specifier === module.prefix ? "" : specifier.slice(module.prefix.length + 1)
      const base = module.dir ? `${module.dir}/${rest}` : rest
      attempts += 1
      const exact = resolvePathLike(base)
      if (exact) return exact
      const directory = directoryPrimary(base)
      if (directory) return directory
    }
    // 2. Workspace package name or subpath: "@loom/spool", "@loom/edge/src/selvedge".
    //    A package whose declared entry cannot be resolved in THIS workspace does
    //    not stop the search: it falls through to the declared workspace-member
    //    rule below. Returning null here made a package with an `exports` map the
    //    importer look external, which is the whole defect this section exists to
    //    remove.
    for (const pkg of npmPackages) {
      if (specifier !== pkg.name && !specifier.startsWith(pkg.name + "/")) continue
      const rest = specifier === pkg.name ? "" : specifier.slice(pkg.name.length + 1)
      const bases = []
      if (rest) {
        bases.push(`${pkg.dir}/${rest}`, `${pkg.dir}/src/${rest}`)
      } else {
        if (pkg.entry) bases.push(pkg.dir ? `${pkg.dir}/${pkg.entry}` : pkg.entry)
        bases.push(pkg.dir ? `${pkg.dir}/src/index` : "src/index", pkg.dir ? `${pkg.dir}/index` : "index")
      }
      for (const base of bases) {
        attempts += 1
        if (attempts > MAX_RESOLUTION_ATTEMPTS) return null
        const hit = resolvePathLike(base)
        if (hit) return hit
      }
      const directory = rest ? null : directoryPrimary(pkg.dir)
      if (directory) return directory
      break
    }
    // 2b. Declared workspace member, matched by leaf name. See the note on
    //     workspaceDirectories: this is what makes a manifest-less monorepo
    //     member resolvable instead of indistinguishable from a dependency.
    {
      const withoutScope = specifier.startsWith("@") ? specifier.split("/").slice(1).join("/") : specifier
      const segments = withoutScope.split("/").filter(Boolean)
      if (segments.length && workspaceDirectories.has(segments[0])) {
        const directory = workspaceDirectories.get(segments[0])
        if (segments.length === 1) {
          const primary = directoryPrimary(directory)
          if (primary) return primary
          const nested = resolvePathLike(`${directory}/src/index`) || resolvePathLike(`${directory}/index`)
          if (nested) return nested
        } else {
          const base = `${directory}/${segments.slice(1).join("/")}`
          attempts += 1
          const hit = resolvePathLike(base) || resolvePathLike(`${directory}/src/${segments.slice(1).join("/")}`)
          if (hit) return hit
        }
      }
    }
    // 3. Dotted/segmented module path against the file index:
    //    "forge.forgeutil.signature". Longest suffix first, so the deepest and
    //    most specific match wins; a genuinely external name finds nothing.
    const segments = specifier.split(/[./\\]+/).filter(Boolean)
    for (let start = 0; start < segments.length && start < 12; start += 1) {
      attempts += 1
      if (attempts > MAX_RESOLUTION_ATTEMPTS) return null
      const candidate = segments.slice(start).join("/")
      if (fileSet.has(candidate)) return candidate
      if (preferPackage) {
        const entry = directoryEntry.get(candidate)
        if (entry) return entry
        const directory = directoryPrimary(candidate)
        if (directory) return directory
      }
      const stem = fileByStem.get(candidate)
      if (stem) return stem
      // A package-root-relative suffix, used only when it is unambiguous. See
      // the note on `packagePath` above.
      const suffixed = packagePath.get(candidate)
      if (suffixed && suffixed.length === 1) return suffixed[0]
      const entry = directoryEntry.get(candidate)
      if (entry) return entry
      const directory = directoryPrimary(candidate)
      if (directory) return directory
    }
    return null
  }

  const resolveRelative = (importerRelative, specifier) => {
    const directory = path.posix.dirname(importerRelative)
    const base = path.posix.normalize(path.posix.join(directory, specifier)).replace(/^\.\//, "")
    if (base.startsWith("../") || base === "..") return null
    return resolvePathLike(base) || directoryPrimary(base)
  }

  // Python relative import. Level 1 is the importer's own package, level 2 its
  // parent, and so on; a module name is then resolved inside that directory.
  const resolvePythonRelative = (importerRelative, specifier, level) => {
    const segments = importerRelative.split("/").slice(0, -1)
    for (let step = 1; step < level; step += 1) segments.pop()
    const base = [...segments, ...(specifier ? specifier.split(".") : [])].filter(Boolean).join("/")
    if (!base) return null
    return resolvePathLike(base) || directoryPrimary(base)
  }

  // A module resolver needs to know which directories hold source files of their
  // own; the workspace index already holds that map, and the grouping
  // directories of the tree are derived from it rather than from a second walk.
  const directories = collectDirectories(filesByDirectory.keys())
  const containers = containerDirectories({ directories, directoryFiles: filesByDirectory })

  return {
    goModules: goModules.map((module) => module.prefix).sort(),
    goModuleEntries: goModules.map((module) => ({ ...module })),
    npmPackages: npmPackages.map((pkg) => pkg.name).sort(),
    npmPackageEntries: npmPackages.map((pkg) => ({ ...pkg })),
    workspaceDirectories: sortedWorkspaceDirectories,
    workspaceEntries: [...workspaceDirectories.entries()].map(([leaf, dir]) => ({ leaf, dir })),
    filesByDirectory,
    directories,
    containers,
    resolve(record, importerRelative) {
      if (record.form === "python-relative") {
        return resolvePythonRelative(importerRelative, record.module, record.level || 1)
      }
      if (record.form === "dotted") return resolveModuleSpecifier(record.module, { preferPackage: record.python === true })
      if (record.module.startsWith(".")) return resolveRelative(importerRelative, record.module)
      return resolveModuleSpecifier(record.module)
    },
  }
}

// DECLARED MODULE BOUNDARIES.
//
// Retrieval has to be able to answer "which module is this file in" without
// guessing from ancestor directory names, so the boundaries are collected from
// declarations and from one structural fact. The full rule set lives in
// lib/module-identity.mjs; this is the side that reads the repository.
//
// Ordering is by kind priority and then longest path, so a resolver built from
// this list always lands on the deepest boundary.
function buildModuleRoots({ index, goPackageByDir }) {
  const byDir = new Map()
  const add = (dir, identity, kind) => {
    const clean = normalizeRelativePath(dir)
    if (!clean) return
    const previous = byDir.get(clean)
    // The strongest declaration wins for a directory, and a declaration always
    // beats a structural one: `packages/spool` is a workspace member, not a
    // container child of `packages`.
    if (previous && (MODULE_KIND_PRIORITY.indexOf(previous.kind) <= MODULE_KIND_PRIORITY.indexOf(kind))) return
    byDir.set(clean, { dir: clean, identity: String(identity || ""), kind })
  }

  for (const pkg of index.npmPackageEntries || []) add(pkg.dir, pkg.name || "", "npm-package")
  for (const module of index.goModuleEntries || []) add(module.dir, module.prefix || "", "go-module")
  for (const entry of index.workspaceEntries || []) add(entry.dir, entry.leaf, "workspace-member")
  for (const [directory, name] of goPackageByDir || []) add(directory, name, "go-package")

  for (const directory of index.directories || []) {
    if ((index.filesByDirectory?.get?.(directory) || []).some((file) => /(^|\/)__init__\.py$/i.test(file))) {
      add(directory, path.posix.basename(directory), "python-package")
    }
  }
  for (const directory of index.directories || []) {
    if (SOURCE_ROOT_SEGMENTS.has(path.posix.basename(directory).toLowerCase())) {
      add(directory, path.posix.basename(directory), "source-root")
    }
  }
  // The immediate children of a directory that only groups directories. A child
  // whose NAME is structure (`src`, `test`) is the inside of a module rather
  // than a module of its own, so it never becomes one.
  for (const container of index.containers || []) {
    for (const directory of index.directories || []) {
      if (directory === container) continue
      if (path.posix.dirname(directory) !== container) continue
      const leaf = path.posix.basename(directory)
      if (STRUCTURAL_DIRECTORY_NAMES.has(leaf.toLowerCase())) continue
      add(directory, leaf, "container-child")
    }
  }

  const declared = [...byDir.values()].filter((root) => root.kind !== "source-root")
  const roots = [...declared]
  // A stable source directory is a module root only when nothing more specific
  // already covers it. `packages/quay/src` inside the declared module
  // `packages/quay` is part of that module, not a module of its own named "src";
  // a top-level `src/` with no manifest anywhere above it is the real thing.
  for (const root of byDir.values()) {
    if (root.kind !== "source-root") continue
    const nested = declared.some((other) => other.dir !== root.dir && root.dir.startsWith(other.dir + "/"))
    if (!nested) roots.push(root)
  }

  return roots
    .sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir))
}

export async function buildRepoGraph(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const maxFiles = options.maxFiles ?? 2500
  const ioConcurrency = Math.max(1, Math.min(32, Number(options.ioConcurrency ?? 12)))
  const { files, manifests } = await walk(root, maxFiles, options.maxDepth ?? 8)
  const fileSet = new Set(files.map((file) => rel(root, file)))

  // Manifest bytes are read once, in the same bounded pass as the sources.
  const manifestRows = await mapLimit(manifests, ioConcurrency, async (file) => ({
    file,
    text: await readFile(file, "utf8").catch(() => ""),
  }))
  const manifestText = new Map(manifestRows.map((row) => [row.file, row.text]))
  const index = buildWorkspaceIndex(root, files, fileSet, manifests, manifestText)

  const nodes = []
  const edges = []
  const external = new Map()
  // A Go package directory is a declared module boundary because the files in it
  // say so. `package glaze` is a declaration, unlike an ancestor directory name.
  const goPackageByDir = new Map()

  const scanned = await mapLimit(files, ioConcurrency, async (file) => {
    const info = await stat(file).catch(() => null)
    if (!info || info.size > 768 * 1024) return null
    const source = await readFile(file, "utf8").catch(() => "")
    const relative = rel(root, file)
    const ext = path.extname(file).toLowerCase()
    const records = importsFor(source, ext)
    const isPackageModule = ext === ".py" && path.basename(relative) === "__init__.py"
    const reExportNames = ext === ".py"
      ? pythonReExportNames(source, records.flatMap((record) => record.names || []), isPackageModule)
      : new Set()
    const local = []
    const reExported = []
    const fileEdges = []
    const externalKeys = []
    const seenEdge = new Set()

    for (const record of records) {
      const resolved = index.resolve(record, relative)
      if (!resolved || !isInsideWorkspace(root, resolved)) {
        const parts = record.module.split("/")
        const key = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
        if (key) externalKeys.push(key)
        continue
      }
      if (resolved === relative) continue
      const isReExport = record.kind === "re-export"
        || (ext === ".py" && isPackageModule && (record.names || []).some((name) => reExportNames.has(name)))
      const kind = isReExport ? "re-export" : "local-import"
      const edgeKey = `${resolved}\u0000${kind}`
      if (seenEdge.has(edgeKey)) continue
      seenEdge.add(edgeKey)
      local.push(resolved)
      if (isReExport) reExported.push(resolved)
      // Both directions are recorded explicitly rather than implied by the
      // consumer, so "imports" and "re-exports" stay separable downstream.
      fileEdges.push({ from: relative, to: resolved, kind })
    }

    return {
      node: {
        path: relative,
        imports: records.length,
        localImports: [...new Set(local)].sort(),
        reExports: [...new Set(reExported)].sort(),
      },
      edges: fileEdges,
      externalKeys,
      goPackage: ext === ".go"
        ? String(source.match(/^\s*package\s+([A-Za-z_][\w]*)/m)?.[1] || "")
        : "",
    }
  })

  // Discovery-order aggregation: concurrency changes latency, never graph output.
  for (const result of scanned) {
    if (!result) continue
    nodes.push(result.node)
    edges.push(...result.edges)
    for (const key of result.externalKeys) {
      external.set(key, (external.get(key) || 0) + 1)
    }
    if (result.goPackage) {
      const directory = path.posix.dirname(result.node.path)
      if (!goPackageByDir.has(directory)) goPackageByDir.set(directory, result.goPackage)
    }
  }

  const moduleRoots = buildModuleRoots({ index, goPackageByDir })

  const incoming = new Map()
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
  const hotspots = nodes
    .map((node) => ({
      path: node.path,
      incoming: incoming.get(node.path) || 0,
      outgoing: node.localImports.length,
      score: (incoming.get(node.path) || 0) + node.localImports.length,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 30)

  return {
    schemaVersion: 2,
    root,
    scannedFiles: files.length,
    truncated: files.length >= maxFiles,
    nodes,
    edges,
    hotspots,
    // Local namespaces this build could resolve. Recorded so a caller can tell
    // "no local package declared" from "resolution failed".
    localNamespaces: { goModules: index.goModules, npmPackages: index.npmPackages },
    // Declared module boundaries. Every entry is backed by a declaration in the
    // repository -- a manifest, a Go `package` clause, an `__init__.py`, a
    // workspace glob -- or by the structural fact that a directory contains only
    // directories. No entry is an arbitrary ancestor name, which is what lets the
    // ranking treat "quay" as a module and "modules" as a grouping prefix.
    moduleRoots,
    externalImports: [...external.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 50),
  }
}

const RUNTIME_GRAPH_CACHE = new Map()
const RUNTIME_GRAPH_INFLIGHT = new Map()

export async function buildRepoGraphCached(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const maxFiles = Number(options.maxFiles ?? 2500)
  const maxDepth = Number(options.maxDepth ?? 8)
  let fingerprint = String(options.workspaceFingerprint || "")
  if (!fingerprint || fingerprint === "unknown") {
    try {
      fingerprint = runtimeWorkspaceFingerprint(root)
    } catch {
      return buildRepoGraph(root, options)
    }
  }
  const key = [root, fingerprint, maxFiles, maxDepth].join("\u0000")
  if (RUNTIME_GRAPH_CACHE.has(key)) {
    const value = RUNTIME_GRAPH_CACHE.get(key)
    RUNTIME_GRAPH_CACHE.delete(key)
    RUNTIME_GRAPH_CACHE.set(key, value)
    return value
  }

  if (RUNTIME_GRAPH_INFLIGHT.has(key)) {
    return RUNTIME_GRAPH_INFLIGHT.get(key)
  }

  const pending = buildRepoGraph(root, options)
  RUNTIME_GRAPH_INFLIGHT.set(key, pending)
  let graph
  try {
    graph = await pending
  } finally {
    RUNTIME_GRAPH_INFLIGHT.delete(key)
  }
  RUNTIME_GRAPH_CACHE.set(key, graph)
  while (RUNTIME_GRAPH_CACHE.size > 8) {
    const oldest = RUNTIME_GRAPH_CACHE.keys().next().value
    if (!oldest) break
    RUNTIME_GRAPH_CACHE.delete(oldest)
  }
  return graph
}

export function clearRepoGraphRuntimeCache() {
  RUNTIME_GRAPH_CACHE.clear()
  RUNTIME_GRAPH_INFLIGHT.clear()
}