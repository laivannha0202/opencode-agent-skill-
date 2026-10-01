import { createHash } from "node:crypto"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"

const JOURNAL_DIR = ".ues-work/journals"
const JOURNAL_TAILS = new Map()
const JOURNAL_SEQUENCES = new Map()
const JOURNAL_LOCK_STALE_MS = 15_000
const JOURNAL_LOCK_WAIT_MS = 30_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withCrossProcessJournalLock(file, fn) {
  const lockDir = file + ".lock"
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS
  let delayMs = 5
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > JOURNAL_LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (confirmed && confirmed.ino === info.ino && confirmed.mtimeMs === info.mtimeMs) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) {
        const lockError = new Error("Timed out waiting for UES run journal lock")
        lockError.code = "UES_RUN_JOURNAL_LOCK_TIMEOUT"
        throw lockError
      }
      await sleep(delayMs)
      delayMs = Math.min(80, delayMs * 2)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function cleanRunId(value) {
  const cleaned = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180)
  if (!cleaned) throw new Error("UES run journal requires a runId")
  return cleaned
}

export function runJournalFile(root, runId) {
  return path.join(path.resolve(root), JOURNAL_DIR, cleanRunId(runId) + ".jsonl")
}

async function withJournalLock(file, fn) {
  const previous = JOURNAL_TAILS.get(file) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  JOURNAL_TAILS.set(file, tail)
  await previous.catch(() => {})
  try {
    return await withCrossProcessJournalLock(file, fn)
  } finally {
    release()
    if (JOURNAL_TAILS.get(file) === tail) JOURNAL_TAILS.delete(file)
  }
}

async function nextSequence(file) {
  // The lock is cross-process, but the in-memory sequence cache is not. Re-read
  // the bounded journal while holding the lock so a parent and child process
  // can never reuse the same eventSeq after either side has appended.
  const rows = await readRuntimeEvents(file, { limit: 5000 })
  const persistedMax = rows.reduce((value, row) => Math.max(value, Number(row?.eventSeq || 0)), 0)
  const cachedMax = Number(JOURNAL_SEQUENCES.get(file) || 0)
  const next = Math.max(persistedMax, cachedMax) + 1
  JOURNAL_SEQUENCES.set(file, next)
  return next
}

export async function readRunJournal(root, runId, options = {}) {
  return readRuntimeEvents(runJournalFile(root, runId), {
    limit: Math.max(1, Math.min(5000, Number(options.limit || 5000))),
  })
}

export async function appendRunJournalEvent(root, runId, type, data = {}) {
  const id = cleanRunId(runId)
  const file = runJournalFile(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  return withJournalLock(file, async () => {
    const eventSeq = await nextSequence(file)
    return appendRuntimeEvent(file, type, {
      runId: id,
      eventSeq,
      ...data,
    })
  })
}

export async function createRunJournal(root, input = {}) {
  const runId = cleanRunId(input.runId)
  const file = runJournalFile(root, runId)
  const admission = {
    schemaVersion: 2,
    runId,
    taskHash: input.taskHash ? String(input.taskHash) : null,
    policySnapshotId: input.policySnapshotId ? String(input.policySnapshotId) : null,
    runtimeEpochId: input.runtimeEpochId ? String(input.runtimeEpochId) : null,
    workspaceFingerprint: input.workspaceFingerprint ? String(input.workspaceFingerprint) : null,
    executionProfile: input.executionProfile ? String(input.executionProfile) : null,
    risk: input.risk ? String(input.risk) : null,
  }
  const admissionHash = sha256(admission)
  await mkdir(path.dirname(file), { recursive: true })
  return withJournalLock(file, async () => {
    const existing = await readRuntimeEvents(file, { limit: 5000 })
    const prior = existing.find((row) => row?.type === "run.admitted")
    if (prior) {
      if (prior.admissionHash !== admissionHash) {
        const error = new Error("UES run journal idempotency conflict for " + runId)
        error.code = "UES_RUN_IDEMPOTENCY_CONFLICT"
        throw error
      }
      return { file, runId, admitted: false, idempotent: true, event: prior }
    }
    const eventSeq = await nextSequence(file)
    const event = await appendRuntimeEvent(file, "run.admitted", {
      runId,
      eventSeq,
      admissionHash,
      admission,
    })
    return { file, runId, admitted: true, idempotent: false, event }
  })
}

const SETTLED_TOOL_TYPES = new Set([
  "tool.completed",
  "tool.failed",
  "tool.blocked",
  "tool.interrupted",
])

export function summarizeRunJournalRows(rows = []) {
  const started = new Map()
  const settled = new Set()
  let terminal = null
  let maxEventSeq = 0
  for (const row of rows || []) {
    maxEventSeq = Math.max(maxEventSeq, Number(row?.eventSeq || 0))
    const toolCallId = String(row?.toolCallId || "")
    if (row?.type === "tool.started" && toolCallId) started.set(toolCallId, row)
    if (SETTLED_TOOL_TYPES.has(row?.type) && toolCallId) settled.add(toolCallId)
    if (["run.completed", "run.failed", "run.aborted"].includes(row?.type)) terminal = row
  }
  const danglingToolCalls = [...started.keys()].filter((id) => !settled.has(id))
  return {
    schemaVersion: 2,
    events: rows.length,
    maxEventSeq,
    terminalType: terminal?.type || null,
    terminalAt: terminal?.at || null,
    danglingToolCalls,
  }
}

export async function recoverRunJournal(root, runId, options = {}) {
  const rows = await readRunJournal(root, runId, { limit: 5000 })
  const before = summarizeRunJournalRows(rows)
  const interrupted = []
  if (options.markInterrupted !== false) {
    for (const toolCallId of before.danglingToolCalls) {
      const started = [...rows].reverse().find((row) => row?.type === "tool.started" && String(row?.toolCallId || "") === toolCallId)
      const event = await appendRunJournalEvent(root, runId, "tool.interrupted", {
        toolCallId,
        tool: started?.tool || null,
        reason: "recovered-after-process-boundary",
        replayed: false,
      })
      interrupted.push(event)
    }
  }
  const finalRows = interrupted.length ? await readRunJournal(root, runId, { limit: 5000 }) : rows
  return {
    schemaVersion: 2,
    runId: cleanRunId(runId),
    interruptedToolCalls: interrupted.map((row) => row.toolCallId),
    replayedSideEffects: false,
    summary: summarizeRunJournalRows(finalRows),
  }
}

export async function closeRunJournal(root, runId, outcome = {}) {
  const passed = outcome.passed === true
  const aborted = outcome.aborted === true
  const type = aborted ? "run.aborted" : passed ? "run.completed" : "run.failed"
  return appendRunJournalEvent(root, runId, type, {
    verdict: outcome.verdict ? String(outcome.verdict) : null,
    durationMs: Number.isFinite(Number(outcome.durationMs)) ? Math.max(0, Number(outcome.durationMs)) : null,
  })
}
