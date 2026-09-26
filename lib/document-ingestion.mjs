import { lstat, readFile, realpath } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

const BUILTIN_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".toml", ".ini", ".log", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".java", ".kt", ".kts", ".cs", ".go", ".rs", ".rb", ".php", ".sql", ".css", ".scss",
])
const MARKITDOWN_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".epub", ".zip"])

function inside(root, target) { return target === root || target.startsWith(root + path.sep) }
async function safeFile(root, relative) {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root))
  const requested = path.resolve(base, String(relative || ""))
  if (!inside(base, requested)) throw new Error("document path escapes workspace root")
  const info = await lstat(requested)
  if (!info.isFile()) throw new Error("document path is not a file")
  const actual = await realpath(requested)
  if (!inside(base, actual)) throw new Error("document symlink escapes workspace root")
  return { base, file: actual, info }
}

function runMarkItDown(file, options = {}) {
  const timeout = Math.max(5_000, Math.min(120_000, Number(options.timeoutMs || 30_000)))
  const maxBuffer = Math.max(256 * 1024, Math.min(16 * 1024 * 1024, Number(options.maxBuffer || 4 * 1024 * 1024)))
  const attempts = process.platform === "win32"
    ? [["markitdown.exe", [file]], ["markitdown", [file]], ["py", ["-m", "markitdown", file]], ["python", ["-m", "markitdown", file]]]
    : [["markitdown", [file]], ["python3", ["-m", "markitdown", file]], ["python", ["-m", "markitdown", file]]]
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer, windowsHide: true })
    if (result.status === 0 && String(result.stdout || "").trim()) return { provider: command.includes("python") || command === "py" ? "markitdown-python" : "markitdown-cli", markdown: String(result.stdout) }
    if (result.error?.code !== "ENOENT" && result.status != null) return { provider: "markitdown-unavailable", error: String(result.stderr || result.error?.message || `exit ${result.status}`) }
  }
  return { provider: "markitdown-unavailable", error: "MarkItDown command/module was not found" }
}

export function documentIngestionSupport(file = "") {
  const ext = path.extname(String(file)).toLowerCase()
  return { schemaVersion: 1, extension: ext, builtin: BUILTIN_TEXT_EXTENSIONS.has(ext), markitdown: MARKITDOWN_EXTENSIONS.has(ext), supported: BUILTIN_TEXT_EXTENSIONS.has(ext) || MARKITDOWN_EXTENSIONS.has(ext) }
}

export async function ingestDocument(root, relative, options = {}) {
  const target = await safeFile(root, relative)
  const support = documentIngestionSupport(target.file)
  const maxBytes = Math.max(16 * 1024, Math.min(32 * 1024 * 1024, Number(options.maxBytes || 4 * 1024 * 1024)))
  if (target.info.size > maxBytes) throw new Error(`document exceeds ingestion limit (${target.info.size} > ${maxBytes} bytes)`)
  if (support.builtin) {
    const content = await readFile(target.file, "utf8")
    return { schemaVersion: 1, provider: "builtin-text", file: path.relative(target.base, target.file).replaceAll("\\", "/"), bytes: target.info.size, markdown: content, optionalDependency: false }
  }
  if (support.markitdown) {
    const converted = runMarkItDown(target.file, options)
    if (converted.markdown) return { schemaVersion: 1, provider: converted.provider, file: path.relative(target.base, target.file).replaceAll("\\", "/"), bytes: target.info.size, markdown: converted.markdown, optionalDependency: true }
    const error = new Error(`${converted.error}. Install Microsoft MarkItDown only when Office/PDF ingestion is needed.`)
    error.code = "UES_MARKITDOWN_UNAVAILABLE"
    throw error
  }
  throw new Error(`unsupported document extension: ${support.extension || "(none)"}`)
}
