// Fresh-Pi acceptance for UES 15.3 (A-G).
//
//   node scripts/acceptance-fresh-pi.mjs [--json]
//
// This is deliberately not a unit test. It spawns a BRAND NEW node process that
// loads the real extension through Pi's own `DefaultResourceLoader`, activates it
// against a minimal host stub, and then drives the real handlers. Nothing from
// any earlier test run is in scope: counters start at zero, no language server is
// pre-created, and every number in the receipt comes from this process.
//
// Checks, in order:
//   A  opening status    new metrics are zero, no LSP session pre-created
//   B  repo map          correct top files, bounded payload
//   C  edit fixture      post-write diagnostics arrive, warm session reused
//   D  second edit       coalescing, final result still delivered
//   E  content cache     identical content reuses the parsed artifact
//   F  worktree reuse    the same blob is reused from a second checkout
//   G  session health    no orphan process, no unexpected session churn

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveWindowsCommand } from "../lib/windows-shim.mjs"
import { describeSanitizedEnv, provisioningChildEnv } from "../lib/child-env.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const CHILD_FLAG = "--child"

function run(executable, args, options = {}) {
  if (process.platform !== "win32") return spawnSync(executable, args, options)
  const resolved = resolveWindowsCommand(executable)
  if (!resolved) return { status: 127, stdout: "", stderr: "Unable to resolve: " + executable }
  return spawnSync(resolved.executable, [...resolved.argsPrefix, ...args], options)
}

async function importSdkFromDir(nodeModulesRoot) {
  const entry = path.join(nodeModulesRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js")
  if (!existsSync(entry)) return null
  return { sdk: await import(pathToFileURL(entry).href), sdkEntry: entry }
}

async function loadPiSdk() {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
    return { sdk: await import("@earendil-works/pi-coding-agent"), sdkEntry: entry, tempDir: null }
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
  }
  const globalRoot = run("npm", ["root", "-g"], { encoding: "utf8" })
  if (globalRoot.status === 0) {
    const loaded = await importSdkFromDir(String(globalRoot.stdout || "").trim())
    if (loaded) return { ...loaded, tempDir: null }
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ues-v153-accept-sdk-"))
  const installed = run("npm", [
    "install", "--ignore-scripts", "--no-package-lock", "--no-save",
    "@earendil-works/pi-coding-agent@0.87.1", "typebox@1.3.27",
  ], { cwd: tempDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  if (installed.status !== 0) throw new Error("Unable to provision Pi SDK:\n" + String(installed.stderr || installed.stdout))
  const loaded = await importSdkFromDir(path.join(tempDir, "node_modules"))
  if (!loaded) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw new Error("Provisioned Pi SDK is missing dist/index.js")
  }
  return { ...loaded, tempDir }
}

// Pi loads extension sources through jiti, not through plain node ESM, because
// the sources are TypeScript. Driving the real loader is what makes this an
// acceptance run rather than another unit test, so the same jiti instance is
// used here to obtain the extension's real default export.
async function importExtensionWithJiti(extensionPath) {
  const candidates = [
    path.join(path.dirname(cachedSdkEntry), "..", "node_modules", "jiti", "lib", "jiti.cjs"),
    path.join(path.dirname(cachedSdkEntry), "..", "..", "jiti", "lib", "jiti.cjs"),
  ]
  let createJiti = null
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mod = await import(pathToFileURL(candidate).href).catch(() => null)
    if (mod?.createJiti) { createJiti = mod.createJiti; break }
  }
  if (!createJiti) {
    const viaRequire = (await import("node:module")).createRequire(path.join(path.dirname(cachedSdkEntry), "index.js"))
    const resolved = viaRequire.resolve("jiti")
    const mod = await import(pathToFileURL(resolved).href)
    createJiti = mod.createJiti || mod.default?.createJiti
  }
  if (!createJiti) throw new Error("Unable to resolve jiti, which Pi uses to load extension sources")
  // `typebox` is a peer dependency. In a real install it sits next to this
  // package; here the extension source lives in the repository, so the peer is
  // aliased to the copy provisioned alongside the Pi SDK. Without this the
  // extension would fail to load for a reason that has nothing to do with 15.3.
  const requireFromSdk = (await import("node:module")).createRequire(cachedSdkEntry)
  const alias = {}
  for (const peer of ["typebox", "@sinclair/typebox"]) {
    try { alias[peer] = requireFromSdk.resolve(peer) } catch { /* optional peer */ }
  }
  const jiti = createJiti(pathToFileURL(cachedSdkEntry).href, {
    interopDefault: true,
    fsCache: false,
    moduleCache: false,
    ...(Object.keys(alias).length ? { alias } : {}),
  })
  return jiti.import(extensionPath)
}

// ---------------------------------------------------------------------------
// Child harness
// ---------------------------------------------------------------------------

async function childHarness() {
  const { writeFile, mkdir, readFile } = await import("node:fs/promises")
  const { DefaultResourceLoader } = await importPiSdk()
  const { buildRepoMap } = await import(pathToFileURL(path.join(ROOT, "lib/repo-map.mjs")).href)
  const { buildSemanticIndex } = await import(pathToFileURL(path.join(ROOT, "lib/semantic-index.mjs")).href)
  const { lspPoolStatus, shutdownLspPool } = await import(
    pathToFileURL(path.join(ROOT, "lib/code-intelligence/lsp-pool.mjs")).href
  )

  const workspace = await mkdtemp(path.join(os.tmpdir(), "ues-v153-accept-ws-"))
  const agentDir = path.join(workspace, ".pi-agent")
  const store = path.join(workspace, "content-store")
  const checkout = path.join(workspace, "sandbox")
  const receipt = { checks: [] }
  const record = (name, pass, detail) => {
    receipt.checks.push({ name, pass, ...detail })
    if (!pass) process.exitCode = 1
  }

  // A real git repository with committed content, so the content store resolves
  // to the shared common git directory exactly as it would in production.
  const git = (...args) => run("git", ["-C", workspace, ...args], { encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "ues@example.invalid")
  git("config", "user.name", "UES Acceptance")
  await mkdir(path.join(workspace, "src"), { recursive: true })
  await writeFile(path.join(workspace, "src", "pricing.ts"), [
    "export function calculateOrderTotal(items: { price: number }[]): number {",
    "  return items.reduce((sum, item) => sum + item.price, 0)",
    "}",
    "",
  ].join("\n"), "utf8")
  await writeFile(path.join(workspace, "src", "orders.ts"), [
    'import { calculateOrderTotal } from "./pricing.ts"',
    "export function placeOrder(items: { price: number }[]): number {",
    "  return calculateOrderTotal(items)",
    "}",
    "",
  ].join("\n"), "utf8")
  git("add", "-A")
  git("commit", "-qm", "fixture")

  // --- load the real extension through Pi -------------------------------
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    additionalExtensionPaths: [path.join(ROOT, "pi/extensions/ues.ts")],
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  if (loaded.errors.length) {
    record("pi-loads-extension", false, { errors: loaded.errors.map((e) => String(e.error)) })
    return receipt
  }
  record("pi-loads-extension", true, { extensions: loaded.extensions.length })

  // Minimal host. Only the surface the extension actually uses is implemented,
  // so an unexpected dependency shows up as a thrown error rather than silence.
  const tools = new Map()
  const handlers = new Map()
  const messages = []
  let activeTools = []
  const host = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
    registerTool(tool) { tools.set(tool.name, tool) },
    registerCommand(name, options) { tools.set("command:" + name, options) },
    registerShortcut() {},
    registerRenderer() {},
    addFlag() {},
    setSessionName() {},
    getActiveTools() { return [...activeTools] },
    setActiveTools(next) { activeTools = [...next] },
    getAllTools() { return [...tools.values()].filter((t) => t && t.name) },
    sendMessage(message) { messages.push(message) },
    onTerminalInput() {},
    log() {},
  }

  const extensionPath = loaded.extensions.find((entry) => String(entry.path || "").endsWith("ues.ts"))?.path
  const extensionModule = extensionPath ? await importExtensionWithJiti(extensionPath) : null
  const factory = extensionModule?.default || extensionModule
  if (typeof factory !== "function") {
    record("extension-factory-present", false, {
      found: loaded.extensions.map((e) => String(e.path)),
      exportType: typeof factory,
    })
    return receipt
  }
  factory(host)
  record("extension-factory-present", true, {
    tools: [...tools.keys()].sort(),
    events: [...handlers.keys()].sort(),
  })

  const fire = async (event, payload) => {
    let last
    for (const handler of handlers.get(event) || []) last = await handler(payload, { cwd: workspace, ui: { notify() {} } })
    return last
  }

  // The runtime publishes its counters through /ues-status, so the acceptance
  // reads them from there rather than from the modules directly. That is the
  // same surface an operator has, and it proves the status contract itself.
  const readStatus = async () => {
    messages.length = 0
    await tools.get("command:ues-status").handler("", { ui: { notify() {} } })
    const message = messages[messages.length - 1] || {}
    return { content: String(message.content || ""), details: message.details || {} }
  }

  // A coalesced write is checked by a trailing timer, so the acceptance has to
  // wait for it rather than assume it already ran. The wait is on the observable
  // counter and is bounded; it is not a fixed sleep that would pass whether or
  // not the runtime did the work.
  const waitForChecks = async (target, budgetMs = 20_000) => {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const details = (await readStatus()).details?.incrementalWrite || {}
      const current = Number(details.postWriteChecks || 0)
      if (current >= target) return current
      if (Date.now() > deadline) return current
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // --- A. opening status -------------------------------------------------
  const poolBefore = lspPoolStatus({ includeSessions: true, persistent: true })
  const status = await readStatus()
  const details = status.details
  const newMetrics = {
    postWriteChecks: details.incrementalWrite?.postWriteChecks ?? 0,
    contentArtifactHits: details.contentArtifacts?.contentArtifactHits ?? 0,
    contentArtifactsStored: details.contentArtifacts?.contentArtifactsStored ?? 0,
    contentArtifactEvictions: details.contentArtifacts?.contentArtifactEvictions ?? 0,
    repoMapQueries: details.repoMap?.queries ?? 0,
    repoMapSelected: details.repoMap?.selectedCount ?? 0,
  }
  record("A-status-metrics-zero", Object.values(newMetrics).every((value) => value === 0), { newMetrics })
  record("A-no-lsp-session-precreated", (poolBefore.sessionCount ?? 0) === 0, {
    sessionCount: poolBefore.sessionCount ?? 0,
  })
  record("A-status-schema-bumped", details.statusSchemaVersion === 3, { statusSchemaVersion: details.statusSchemaVersion })
  record("A-status-advertises-v15-3",
    String(status?.content || "").includes("V15.3 incremental write intelligence")
    && String(status?.content || "").includes("V15.3 content-addressed semantic index")
    && String(status?.content || "").includes("V15.3 graph-ranked repo map"),
  { contentHead: String(status?.content || "").split("\n").slice(0, 2).join(" | ") })
  record("A-status-advertises-v15-4",
    String(status?.content || "").includes("V15.4 permission preflight")
    && String(status?.content || "").includes("V15.4 task telemetry")
    && String(status?.content || "").includes("V15.4 compaction recall analytics")
    && String(status?.content || "").includes("V15.4 mutation-shape write detection")
    && String(status?.content || "").includes("V15.4 document ingestion"),
  { contentHead: String(status?.content || "").split("\n").slice(0, 3).join(" | ") })
  record("A-status-v15-4-details",
    details.taskTelemetry?.schemaVersion === 1
    && details.compactionRecall?.schemaVersion === 1,
  {
    taskTelemetrySchemaVersion: details.taskTelemetry?.schemaVersion ?? null,
    compactionRecallSchemaVersion: details.compactionRecall?.schemaVersion ?? null,
  })
  record("A-status-reports-coverage",
    Array.isArray(details.incrementalWrite?.coverage?.supportedWriteTools)
    && details.incrementalWrite.coverage.supportedWriteTools.includes("edit"),
  { coverage: details.incrementalWrite?.coverage })

  // --- B. repo map -------------------------------------------------------
  const codeTool = tools.get("ues_code")
  const mapResult = await codeTool.execute("t1", {
    action: "repo-map",
    query: "calculateOrderTotal",
    contextBudgetChars: 3000,
  }, undefined, undefined, { cwd: workspace })
  const map = mapResult.details?.files ? mapResult.details : JSON.parse(mapResult.content[0].text)
  const topPath = map.files?.[0]?.path
  record("B-repo-map-ranks-target", topPath === "src/pricing.ts", {
    topPath,
    top3: (map.files || []).slice(0, 3).map((row) => row.path),
    reasons: map.files?.[0]?.reasons,
  })
  const mapChars = JSON.stringify(map).length
  record("B-repo-map-bounded", mapChars <= 6000 && (map.files || []).length <= 12, {
    chars: mapChars,
    files: (map.files || []).length,
    contextBudgetChars: map.stats?.contextBudgetChars,
    selectedCount: map.stats?.selectedCount,
  })
  record("B-repo-map-telemetry-moved", Number(details.repoMap?.queries || 0) === 0, {
    note: "status was read before the query; the counter must move after it",
  })
  const detailsAfter = (await readStatus()).details
  record("B-repo-map-telemetry-counted", Number(detailsAfter.repoMap?.queries) === 1
    && Number(detailsAfter.repoMap?.selectedCount) > 0, { repoMap: detailsAfter.repoMap })

  // --- C. post-write feedback -------------------------------------------
  const writeAndObserve = async (relative, source) => {
    await writeFile(path.join(workspace, ...relative.split("/")), source, "utf8")
    return fire("tool_result", {
      type: "tool_result",
      toolCallId: "call-" + relative + "-" + source.length,
      toolName: "edit",
      input: { file: relative },
      content: [{ type: "text", text: "edited " + relative }],
      isError: false,
    })
  }

  const c1 = await writeAndObserve("src/pricing.ts", [
    "export function calculateOrderTotal(items: { price: number }[]): number {",
    "  return items.reduce((sum, item) => sum + item.price, 0)",
    "}",
    "export const broken: number = \"not a number\"",
    "",
  ].join("\n"))
  const c1Text = (c1?.content || []).map((part) => part.text).join("\n")
  const c1Detail = c1?.details?.uesPostWrite || {}
  record("C-post-write-arrives", typeof c1Text === "string" && c1Text.includes("UES post-write src/pricing.ts"), {
    text: c1Text.split("\n")[0],
  })
  record("C-post-write-reports-error", c1Detail.status === "errors" && c1Detail.errorCount >= 1, c1Detail)
  record("C-post-write-keeps-host-content",
    (c1?.content || []).some((part) => part.text === "edited src/pricing.ts"),
  { contentBlocks: (c1?.content || []).length })
  record("C-post-write-preserves-error-flag", c1?.isError === false, { isError: c1?.isError })

  const c2 = await writeAndObserve("src/pricing.ts", [
    "export function calculateOrderTotal(items: { price: number }[]): number {",
    "  return items.reduce((sum, item) => sum + item.price, 0)",
    "}",
    "",
  ].join("\n"))
  const c2Detail = c2?.details?.uesPostWrite || {}
  // With a real language server the second edit lands inside the adaptive
  // coalescing window, so an immediate `pending` is the correct answer rather
  // than a second two-second check. What matters is that the final verdict
  // arrives and is bound to the newest content.
  record("C2-immediate-answer-is-honest",
    c2Detail.status === "confirmed-clean" || c2Detail.status === "pending",
  c2Detail)
  record("C2-no-stale-feedback", c2Detail.stale !== true && c2Detail.superseded !== true, c2Detail)

  const checksBeforeSettle = (await readStatus()).details?.incrementalWrite?.postWriteChecks || 0
  if (c2Detail.status === "pending") await waitForChecks(checksBeforeSettle + 1)
  const settled = await fire("tool_result", {
    type: "tool_result",
    toolCallId: "call-settle",
    toolName: "read",
    input: { file: "src/pricing.ts" },
    content: [{ type: "text", text: "read" }],
    isError: false,
  })
  const settledText = (settled?.content || []).map((part) => part.text).join("\n")
  const settledMatch = settledText.match(/UES post-write src\/pricing\.ts: ([a-z-]+) \(complete=(true|false)/)
  const settledStatus = settledMatch ? settledMatch[1] : null
  const settledComplete = settledMatch ? settledMatch[2] === "true" : false
  record("C2-final-verdict-delivered", settledStatus != null, {
    delivered: settled?.details?.uesPostWrite?.delivered,
    head: settledText.split("\n").filter(Boolean).slice(-1)[0],
  })
  record("C2-confirmed-clean-is-honest", settledStatus === "confirmed-clean" && settledComplete, {
    settledStatus,
    settledComplete,
  })

  // --- D. coalescing -----------------------------------------------------
  const before = (await readStatus()).details?.incrementalWrite || {}
  for (const marker of ["d1", "d2", "d3"]) {
    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "burst-" + marker,
      toolName: "edit",
      input: { file: "src/orders.ts" },
      content: [{ type: "text", text: "burst " + marker }],
      isError: false,
    })
  }
  // Any later tool result carries whatever a coalesced write is still owed.
  const after = (await readStatus()).details?.incrementalWrite || {}
  record("D-coalescing-reduced-checks", Number(after.postWriteChecks) - Number(before.postWriteChecks) <= 2, {
    before: before.postWriteChecks,
    after: after.postWriteChecks,
    coalesced: after.postWriteCoalesced,
  })

  await waitForChecks(Number(after.postWriteChecks) + 1)
  const drained = await fire("tool_result", {
    type: "tool_result",
    toolCallId: "burst-drain",
    toolName: "read",
    input: { file: "src/orders.ts" },
    content: [{ type: "text", text: "read" }],
    isError: false,
  })
  const drainedText = (drained?.content || []).map((part) => part.text).join("\n")
  record("D-coalesced-result-delivered", drainedText.includes("UES post-write src/orders.ts"), {
    delivered: drained?.details?.uesPostWrite?.delivered,
    head: drainedText.split("\n").filter(Boolean)[0],
  })

  // --- E. content-addressed cache ---------------------------------------
  const index = async (root) => buildSemanticIndex(root, { rebuild: true, maxFiles: 200, contentStoreDir: store })
  const e1 = await index(workspace)
  const e2 = await buildSemanticIndex(workspace, { maxFiles: 200, contentStoreDir: store })
  record("E-warm-reuse", e2.stats.reparsed === 0 && e2.stats.reused === e1.stats.files, {
    cold: { reparsed: e1.stats.reparsed, files: e1.stats.files },
    warm: { reparsed: e2.stats.reparsed, reused: e2.stats.reused },
  })
  // Same path, different content, identical byte length.
  const sameLen = "export function otherSymbolName(): number {\n  return 2\n}\n"
  const current = await readFile(path.join(workspace, "src", "pricing.ts"), "utf8")
  await writeFile(path.join(workspace, "src", "pricing.ts"), sameLen.padEnd(current.length, " "), "utf8")
  const e3 = await buildSemanticIndex(workspace, { maxFiles: 200, contentStoreDir: store })
  const pricingEntry = e3.index.files["src/pricing.ts"]
  record("E-no-false-cache-hit", e3.stats.reparsed >= 1 && pricingEntry.symbols.some((s) => s.name === "otherSymbolName"), {
    reparsed: e3.stats.reparsed,
    symbols: pricingEntry.symbols.map((s) => s.name),
  })

  // --- F. cross-worktree reuse ------------------------------------------
  // The checkout is registered as a real git worktree of this repository, then
  // populated with byte-identical content. That is the situation a task sandbox
  // runs in, and the only thing its reuse can come from is the shared
  // content-addressed store: its own workspace cache starts empty.
  await mkdir(path.join(workspace, "sandbox"), { recursive: true })
  git("worktree", "add", "-q", "-b", "sandbox", checkout)
  await mkdir(path.join(checkout, "src"), { recursive: true })
  await writeFile(path.join(checkout, "src", "pricing.ts"), current, "utf8")
  await writeFile(path.join(checkout, "src", "orders.ts"), "export const x = 1\n", "utf8")
  const f1 = await buildSemanticIndex(checkout, { rebuild: true, maxFiles: 200, contentStoreDir: store })
  // The checkout holds one file whose content the store has never seen, so a
  // single reparse is correct. The property under test is narrower and is the
  // one that matters: the file whose bytes already existed is reused, out of the
  // shared store, under the same artifact id.
  const checkoutPricing = f1.index.files["src/pricing.ts"]
  const mainPricing = e1.index.files["src/pricing.ts"]
  record("F-cross-worktree-reuse",
    Boolean(checkoutPricing)
    && checkoutPricing.artifactId === mainPricing.artifactId
    && f1.stats.reparsed === 1
    && checkoutPricing.symbols.some((s) => s.name === "calculateOrderTotal"),
  {
    reparsed: f1.stats.reparsed,
    reused: f1.stats.reused,
    sameArtifact: checkoutPricing?.artifactId === mainPricing?.artifactId,
    symbols: checkoutPricing?.symbols?.map((s) => s.name),
  })

  // --- G. session health -------------------------------------------------
  const poolAfter = lspPoolStatus({ includeSessions: true, persistent: true })
  await shutdownLspPool()
  const poolFinal = lspPoolStatus({ includeSessions: true, persistent: true })
  record("G-session-bounded", Number(poolAfter.sessionCount ?? 0) <= 2, {
    sessionCount: poolAfter.sessionCount ?? 0,
    metrics: poolAfter.metrics,
  })
  record("G-shutdown-releases-sessions", Number(poolFinal.sessionCount ?? 0) === 0, {
    sessionCount: poolFinal.sessionCount ?? 0,
  })

  receipt.workspace = workspace
  return receipt
}

let cachedSdk = null
let cachedSdkTempDir = null
let cachedSdkEntry = ""
async function importPiSdk() {
  if (cachedSdk) return cachedSdk
  const loaded = await loadPiSdk()
  cachedSdk = loaded.sdk
  cachedSdkTempDir = loaded.tempDir
  cachedSdkEntry = loaded.sdkEntry
  return cachedSdk
}

if (process.argv.includes(CHILD_FLAG)) {
  // The status handler is what publishes the counters; capture it so the
  // acceptance can read the same numbers an operator sees.
  const receipt = await childHarness()
  process.stdout.write("__UES_RECEIPT__" + JSON.stringify(receipt) + "\n")
} else {
  // The spawn boundary is the ONLY place npm's scope-bound configuration is
  // removed. Under `npm run`, npm exports its own configuration into the script's
  // environment, and the nested project-scoped `npm install` below inherits a
  // user-scoped `allow-scripts` from ~/.npmrc and refuses to run
  // (EALLOWSCRIPTS). Nothing else is touched: PATH, the Pi variables, provider
  // credentials and every user variable are passed through verbatim.
  const sanitizedEnv = provisioningChildEnv(process.env)
  const child = run(process.execPath, [path.join(HERE, "acceptance-fresh-pi.mjs"), CHILD_FLAG, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: sanitizedEnv,
  })
  const marker = String(child.stdout || "").indexOf("__UES_RECEIPT__")
  let receipt = { checks: [] }
  if (marker >= 0) {
    const line = String(child.stdout).slice(marker + "__UES_RECEIPT__".length).split("\n")[0]
    try { receipt = JSON.parse(line) } catch (error) { receipt = { checks: [], parseError: String(error) } }
  } else {
    receipt = { checks: [], spawnError: String(child.stderr || child.stdout || "child produced no receipt") }
  }
  const failed = receipt.checks.filter((check) => !check.pass)
  if (receipt.workspace) await rm(receipt.workspace, { recursive: true, force: true }).catch(() => {})
  const output = {
    schemaVersion: 1,
    kind: "ues-v15-4-fresh-pi-acceptance",
    node: process.version,
    childExit: child.status,
    // Variable NAMES only. A value in this environment may be a credential.
    sanitizedEnvKeys: describeSanitizedEnv(process.env),
    checks: receipt.checks,
    failures: failed.map((check) => check.name),
    pass: failed.length === 0 && child.status === 0,
  }
  process.stdout.write(JSON.stringify(output, null, process.argv.includes("--json") ? 2 : 0) + "\n")
  if (!output.pass) {
    process.stderr.write(String(child.stderr || "").slice(0, 4000) + "\n")
    process.exitCode = 1
  }
}
