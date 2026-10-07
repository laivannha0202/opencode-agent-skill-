import { readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runSupervisedProcess } from "../lib/process-supervisor.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testRoot = path.join(root, "test")

function bounded(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await walk(absolute))
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) output.push(absolute)
  }
  return output
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function selectedFiles(allFiles) {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  if (!positional.length) return allFiles
  const requested = new Set(positional.map((item) => path.resolve(root, item)))
  return allFiles.filter((file) => requested.has(path.resolve(file)))
}

function parseFlag(name, fallback) {
  const direct = process.argv.find((arg) => arg.startsWith(name + "="))
  if (!direct) return fallback
  return direct.slice(name.length + 1)
}

const cpuCap = process.platform === "win32" ? 4 : 6
// Windows cap is 4, not 6, by measurement (V16.12 stability proof): the suite
// is filesystem/process-spawn heavy and thrashes at 6 on NTFS/Defender. Full
// suite 244/244: c4 green 3/3 (114s/121s/114s) vs c6 flaky with moving
// failures (2 of 4 c6 runs failed different files) and barely faster when
// green (109s). Slowest file c4->c6: installer 19s->51s, consistency
// 28s->40s. Explicit --concurrency / UES_TEST_CONCURRENCY still override.
const cpuDefault = Math.max(2, Math.min(cpuCap, os.availableParallelism?.() || os.cpus().length || 4))
const concurrency = bounded(
  parseFlag("--concurrency", process.env.UES_TEST_CONCURRENCY),
  cpuDefault,
  1,
  12,
)
// Global per-file hang bound. This stays tight on purpose: it is the default for
// every test file, and lowering it costs hang-detection sensitivity across the
// whole suite. A file that legitimately needs longer declares it below rather
// than pushing the global bound up.
const defaultTimeoutMs = bounded(
  parseFlag("--timeout-ms", process.env.UES_TEST_FILE_TIMEOUT_MS),
  45_000,
  5_000,
  10 * 60_000,
)

// Scoped, opt-in per-file bounds, keyed by repo-relative test path.
//
// An entry here is a deliberate exception, not a precedent: it must be justified
// by a file that is legitimately slow (for example driving a real language
// server over a large source file), and every other file keeps the tight global
// bound. Keep this list as short as possible -- an entry is a hole in hang
// detection, so remove it as soon as the file gets cheaper.
const FILE_TIMEOUT_OVERRIDES = new Map([
  // Drives a real typescript-language-server over a 242KB source file, so its
  // floor is tens of seconds. Observed ~43-46s, so it genuinely straddles the
  // 45s default under load. Next-slowest file in the suite runs in ~29s.
  ["test/code-intelligence-v15-2-hardening.test.mjs", 90_000],
  // Spawns the real install/uninstall scripts ~21 times, once per state scenario,
  // each a full node process that copies the managed resource tree. Measured
  // 36s unloaded on this machine, so it sits on the same 45s boundary as the
  // entry above and crosses it whenever the suite runs at concurrency > 1. It
  // depends on no module under change: it imports only node builtins and spawns
  // scripts/install.mjs and scripts/uninstall.mjs, neither of which is touched
  // by the retrieval work. This is the declared per-file bound the runner
  // documents, not a relaxation of the global one.
  ["test/installer.test.mjs", 90_000],
])
const files = selectedFiles((await walk(testRoot)).sort((a, b) => relative(a).localeCompare(relative(b))))

if (!files.length) {
  console.error("No matching test files.")
  process.exitCode = 2
} else {
  console.log(`UES bounded test runner: ${files.length} files; concurrency=${concurrency}; perFileTimeoutMs=${defaultTimeoutMs}; scopedOverrides=${FILE_TIMEOUT_OVERRIDES.size}`)

  let cursor = 0
  let passed = 0
  const failures = []
  const startedAt = Date.now()

  async function worker(workerId) {
    while (true) {
      const index = cursor++
      if (index >= files.length) return
      const file = files[index]
      const label = relative(file)
      const ordinal = index + 1
      console.log(`[${ordinal}/${files.length}] RUN  ${label}`)

      // Scoped bound for this file; the tight global default otherwise.
      const timeoutMs = FILE_TIMEOUT_OVERRIDES.get(label) ?? defaultTimeoutMs

      const result = await runSupervisedProcess(
        process.execPath,
        ["--test", file],
        {
          cwd: root,
          hardTimeoutMs: timeoutMs,
          idleTimeoutMs: 0,
          killGraceMs: 500,
          drainTimeoutMs: 2_000,
          stdoutLimit: 8 * 1024 * 1024,
          stderrLimit: 4 * 1024 * 1024,
          env: {
            ...process.env,
            UES_BOUNDED_TEST_RUNNER: "1",
          },
        },
      )

      if (result.exitCode === 0 && !result.stopReason) {
        passed += 1
        console.log(`[${ordinal}/${files.length}] PASS ${label} (${result.durationMs}ms)`)
        continue
      }

      const timedOut = result.stopReason === "hard-timeout"
      const reason = timedOut
        ? `HANG/TIMEOUT after ${timeoutMs}ms`
        : result.stopReason
          ? `STOPPED: ${result.stopReason}`
          : `EXIT ${result.exitCode}`
      failures.push({
        file: label,
        reason,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
        durationMs: result.durationMs,
      })

      console.error(`[${ordinal}/${files.length}] FAIL ${label}: ${reason}`)
      const stdout = String(result.stdout || "").trim()
      const stderr = String(result.stderr || "").trim()
      if (stdout) console.error("\n--- stdout: " + label + " ---\n" + stdout.slice(-64_000))
      if (stderr) console.error("\n--- stderr: " + label + " ---\n" + stderr.slice(-32_000))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, (_, index) => worker(index + 1)))

  const durationMs = Date.now() - startedAt
  console.log("")
  console.log("UES bounded test summary")
  console.log(`files: ${files.length}`)
  console.log(`pass: ${passed}`)
  console.log(`fail: ${failures.length}`)
  console.log(`duration_ms: ${durationMs}`)

  if (failures.length) {
    console.error("")
    console.error("Failing or leaking test files:")
    for (const failure of failures) {
      console.error(`- ${failure.file}: ${failure.reason}; duration=${failure.durationMs}ms`)
    }
    process.exitCode = 1
  }
}
