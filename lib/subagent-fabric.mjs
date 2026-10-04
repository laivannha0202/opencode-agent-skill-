// V16.5 Phase 6: Subagent Fabric V2 (bounded fresh-context specialist delegation).
//
// This module decides and bounds delegation. It does NOT spawn processes: the
// existing Pi child spawn + execution-ownership + process-supervisor path in
// pi/extensions/ues.ts remains the single process framework. No swarm.
//
// Hard bounds:
//   default active children  : 2   (configurable, hard max 3)
//   default delegation depth : 1   (hard max 2)
//   cycle guard              : an agent may not appear twice in its own stack
//
// Child context is fresh by default. Parent conversation, full skill bodies and
// full tool sets are NOT copied into children; the parent passes an explicit,
// bounded brief plus evidence references.

import { createHash, randomUUID } from "node:crypto"
import { skillRegistry } from "./skill-registry.mjs"

export const SUBAGENT_FABRIC_SCHEMA_VERSION = 2
export const DELEGATION_DECISION = Object.freeze({ DELEGATE: "delegate", PARENT_DIRECT: "parent-direct" })
export const FABRIC_LIMITS = Object.freeze({
  defaultActiveChildren: 2,
  maxActiveChildren: 3,
  defaultDepth: 1,
  hardMaxDepth: 2,
  maxChildTaskChars: 3_000,
  maxChildContextChars: 6_000,
  defaultTimeoutMs: 180_000,
  heartbeatIntervalMs: 15_000,
})

// Requested V16.5 roles mapped onto the EXISTING 12-agent catalog. No new roles.
export const DELEGATION_ROLES = Object.freeze({
  explore: Object.freeze({ agent: "codebase-mapper", readOnly: true, skills: ["repo-explorer", "context-engineering"] }),
  diagnose: Object.freeze({ agent: "debugger", readOnly: true, skills: ["bug-diagnosis", "test-verification"] }),
  implement: Object.freeze({ agent: "executor", readOnly: false, skills: ["implementation-engineer", "test-verification"] }),
  review: Object.freeze({ agent: "reviewer", readOnly: true, skills: ["code-review", "change-impact-analysis"] }),
  "test-analysis": Object.freeze({ agent: "integration-verifier", readOnly: true, skills: ["test-verification", "change-impact-analysis"] }),
  architecture: Object.freeze({ agent: "architect", readOnly: true, skills: ["software-architect", "task-planner"] }),
})

export const DELEGATION_STOP_REASONS = Object.freeze({
  CHILD_COMPLETED: "child-completed",
  CHILD_FAILED: "child-failed",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  INACTIVITY: "inactivity",
  DEPTH_EXCEEDED: "depth-exceeded",
  CYCLE_DETECTED: "cycle-detected",
  CAPACITY_EXCEEDED: "capacity-exceeded",
  ORPHAN_REAPED: "orphan-reaped",
})

const CHILD_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed-out",
  REAPED: "reaped",
  TERMINAL: Object.freeze(["completed", "failed", "cancelled", "timed-out", "reaped"]),
})

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)
}

function normalize(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
}

/**
 * Deterministic delegate-vs-parent-direct decision from task evidence.
 * Every returned reason is a fact about the input, not a guess about the model.
 */
export function decideDelegation(input = {}) {
  const text = normalize(input.task)
  const reasons = []
  const evidence = Array.isArray(input.repoEvidence) ? input.repoEvidence.map(String) : []
  const role = String(input.requestedRole || "")
  const readOnly = DELEGATION_ROLES[role]?.readOnly === true

  let score = 0

  // Independence requirement: review/test roles are only meaningful out-of-process.
  if (role === "review" || role === "test-analysis") {
    score += 60
    reasons.push({ signal: "independence-required", detail: role })
  }
  // Context separation: exploration across an unfamiliar surface.
  const explorationSignals = ["explore", "investigate", "where is", "find all", "map", "survey", "trace", "why", "root cause", "khong ro", "tim cho"]
  if (explorationSignals.some((token) => text.includes(token))) {
    score += 35
    reasons.push({ signal: "context-separation", detail: explorationSignals.filter((token) => text.includes(token)).join(",") })
  }
  // Task decomposition: several independent file scopes.
  const scopes = unique(evidence.map((file) => file.split("/").slice(0, 2).join("/")).filter(Boolean))
  if (evidence.length >= 5 || scopes.length >= 3) {
    score += 30
    reasons.push({ signal: "decomposable", detail: `${evidence.length} files / ${scopes.length} scopes` })
  }
  if (evidence.length >= 25) {
    score += 15
    reasons.push({ signal: "high-context-pressure", detail: `${evidence.length} files` })
  }

  // Overrides toward parent-direct.
  const fileTargets = (text.match(/\b([\w.-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|cs|php|rb|md|json))\b/g) || []).length
  if (fileTargets === 1 && evidence.length <= 2) {
    score -= 55
    reasons.push({ signal: "single-file-target", detail: input.task.slice(0, 80) })
  }
  if (/\b(rename|bump|typo|whitespace|changelog|readme|version string|add a test that already exists)\b/.test(text)) {
    score -= 60
    reasons.push({ signal: "deterministic-change", detail: "mechanical edit with a known answer" })
  }
  if (input.contextPressure === "low") {
    score -= 25
    reasons.push({ signal: "low-context-pressure", detail: "parent context is not under pressure" })
  }
  if (!role) {
    score -= 40
    reasons.push({ signal: "no-specialist-role-requested", detail: "no evidence that a specialist helps" })
  }

  const decision = score > 0 ? DELEGATION_DECISION.DELEGATE : DELEGATION_DECISION.PARENT_DIRECT
  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    decision,
    score,
    requestedRole: role || null,
    readOnly,
    reasons,
    // Overhead estimate is structural, never a measured latency claim.
    overheadNote: "delegation cost = child process start + fresh context rebuild; benefit = context separation / independence",
  }
}

/** Compile the bounded plan for one delegation decision. */
export function planDelegation(input = {}) {
  const decision = input.decision || decideDelegation(input)
  if (decision.decision === DELEGATION_DECISION.PARENT_DIRECT) {
    return {
      schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
      decision: DELEGATION_DECISION.PARENT_DIRECT,
      children: [],
      reasons: decision.reasons,
      activeChildren: 0,
    }
  }
  const roleSpec = DELEGATION_ROLES[decision.requestedRole]
  if (!roleSpec) throw new Error(`unknown delegation role: ${decision.requestedRole}`)
  const activeChildren = Math.max(0, Math.min(FABRIC_LIMITS.maxActiveChildren, Number(input.maxActiveChildren) || FABRIC_LIMITS.defaultActiveChildren))
  const parallel = input.parallel === true && activeChildren > 1
  const child = {
    role: decision.requestedRole,
    agent: roleSpec.agent,
    readOnly: roleSpec.readOnly,
    skillIds: roleSpec.skills.filter((id) => skillRegistry().byId.has(id)),
    minTools: roleSpec.readOnly ? ["read", "grep", "find", "ls"] : ["read", "grep", "edit", "bash"],
    freshContext: true,
    copiesParentConversation: false,
  }
  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    decision: DELEGATION_DECISION.DELEGATE,
    reasons: decision.reasons,
    children: [child],
    activeChildren: Math.min(1, activeChildren),
    parallelCapable: parallel,
    parallelPolicy: parallel ? "read-only-scopes-only" : "single-child",
  }
}

export function createDelegationSession(input = {}) {
  const maxActive = Math.max(1, Math.min(FABRIC_LIMITS.maxActiveChildren, Number(input.maxActiveChildren) || FABRIC_LIMITS.defaultActiveChildren))
  const depth = Math.max(0, Math.min(FABRIC_LIMITS.hardMaxDepth, Number(input.depth) || 0))
  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    sessionId: input.sessionId || `dg-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    parentId: String(input.parentId || "parent"),
    runId: String(input.runId || ""),
    depth,
    hardMaxDepth: FABRIC_LIMITS.hardMaxDepth,
    stack: unique([...(input.stack || []), String(input.parentAgent || "").trim()].filter(Boolean)),
    maxActiveChildren: maxActive,
    children: [],
    cancelled: false,
    createdAt: new Date().toISOString(),
    counters: { spawned: 0, completed: 0, failed: 0, cancelled: 0, reaped: 0, rejected: 0 },
  }
}

/**
 * Build the child's fresh-context brief.
 * Explicitly records what is NOT copied, so the omission is auditable.
 */
export function buildChildContext(input = {}) {
  const task = String(input.task || "").slice(0, FABRIC_LIMITS.maxChildTaskChars)
  const roleSpec = DELEGATION_ROLES[input.role] || DELEGATION_ROLES.explore
  const relevantFiles = unique(input.relevantFiles).slice(0, 40)
  const symbols = unique(input.symbols).slice(0, 40)
  const evidenceRefs = unique(input.evidenceRefs).slice(0, 20)
  const constraints = unique(input.constraints).slice(0, 20)
  const skillCapsule = input.skillCapsuleText ? String(input.skillCapsuleText).slice(0, FABRIC_LIMITS.maxChildContextChars) : ""

  const lines = [
    `# Delegated task (${input.role})`,
    "",
    "## Task",
    task || "(no task text)",
  ]
  if (constraints.length) lines.push("", "## Constraints (non-negotiable)", ...constraints.map((row) => `- ${row}`))
  if (relevantFiles.length) lines.push("", "## Relevant files (bounded, evidence-scoped)", ...relevantFiles.map((row) => `- ${row}`))
  if (symbols.length) lines.push("", "## Relevant symbols", ...symbols.map((row) => `- ${row}`))
  if (evidenceRefs.length) lines.push("", "## Evidence references (fetch on demand)", ...evidenceRefs.map((row) => `- ${row}`))
  if (skillCapsule) lines.push("", "## Required skill capsule", skillCapsule)
  lines.push(
    "",
    "## Child rules",
    "- You have a FRESH context. Do not assume any parent conversation you cannot see.",
    "- Do not spawn further subagents beyond the configured depth budget.",
    "- You cannot grant permissions, publish, push, deploy, or mark the task PASS.",
    `- Return ${roleSpec.readOnly ? "findings and evidence only; do not mutate repository state" : "a bounded implementation report with evidence"}.`,
  )

  const text = lines.join("\n")
  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    role: input.role,
    agent: roleSpec.agent,
    readOnly: roleSpec.readOnly,
    minTools: roleSpec.readOnly ? ["read", "grep", "find", "ls"] : ["read", "grep", "edit", "bash"],
    freshContext: true,
    notCopied: [
      "parent-conversation",
      "full-skill-bodies",
      "all-tools",
      "complete-repository",
      "unrelated-prior-attempts",
    ],
    chars: text.length,
    bounded: text.length <= FABRIC_LIMITS.maxChildContextChars + FABRIC_LIMITS.maxChildTaskChars,
    text,
    fingerprint: "child-context:sha256:" + hash([input.role, task, relevantFiles, symbols, evidenceRefs, constraints, skillCapsule]),
  }
}

export function registerChild(session, spec = {}) {
  if (!session || typeof session !== "object") throw new Error("registerChild requires a delegation session")
  if (session.cancelled) {
    session.counters.rejected += 1
    return { ok: false, reason: DELEGATION_STOP_REASONS.CANCELLED }
  }
  const depth = session.depth + 1
  if (depth > session.hardMaxDepth) {
    session.counters.rejected += 1
    return { ok: false, reason: DELEGATION_STOP_REASONS.DEPTH_EXCEEDED, depth, hardMaxDepth: session.hardMaxDepth }
  }
  const role = String(spec.role || "")
  const agent = String(spec.agent || DELEGATION_ROLES[role]?.agent || "")
  if (session.stack.includes(agent)) {
    session.counters.rejected += 1
    return { ok: false, reason: DELEGATION_STOP_REASONS.CYCLE_DETECTED, agent }
  }
  const active = session.children.filter((child) => !CHILD_STATUS.TERMINAL.includes(child.status))
  if (active.length >= session.maxActiveChildren) {
    session.counters.rejected += 1
    return { ok: false, reason: DELEGATION_STOP_REASONS.CAPACITY_EXCEEDED, activeChildren: active.length, maxActiveChildren: session.maxActiveChildren }
  }

  const child = {
    childId: `ch-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    parentId: session.parentId,
    sessionId: session.sessionId,
    role: role || null,
    agent: agent || null,
    depth,
    stack: [...session.stack, agent],
    status: CHILD_STATUS.RUNNING,
    readOnly: spec.readOnly !== false,
    freshContext: true,
    taskHash: hash(spec.task || ""),
    taskPreview: String(spec.task || "").replace(/\s+/g, " ").slice(0, 240),
    timeoutMs: Math.max(5_000, Math.min(3_600_000, Number(spec.timeoutMs) || FABRIC_LIMITS.defaultTimeoutMs)),
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    finishedAt: null,
    stopReason: null,
    receipt: null,
  }
  session.children.push(child)
  session.counters.spawned += 1
  return { ok: true, child }
}

export function heartbeatChild(session, childId, patch = {}) {
  const child = session?.children?.find((row) => row.childId === childId)
  if (!child) return { ok: false, reason: "unknown-child" }
  child.lastHeartbeatAt = Date.now()
  if (patch.activityMs !== undefined) child.lastActivityAt = Date.now()
  return { ok: true, childId, lastHeartbeatAt: child.lastHeartbeatAt }
}

/** Fail-closed liveness sweep: timeout, inactivity, orphan reaping. */
export function sweepChildren(session, now = Date.now()) {
  if (!session?.children) return { reaped: [], checked: 0 }
  const reaped = []
  for (const child of session.children) {
    if (CHILD_STATUS.TERMINAL.includes(child.status)) continue
    const idleMs = now - (child.lastActivityAt || child.lastHeartbeatAt)
    if (now - child.startedAt > child.timeoutMs) {
      child.status = CHILD_STATUS.TIMED_OUT
      child.stopReason = DELEGATION_STOP_REASONS.TIMEOUT
    } else if (idleMs > FABRIC_LIMITS.heartbeatIntervalMs * 8) {
      child.status = CHILD_STATUS.TIMED_OUT
      child.stopReason = DELEGATION_STOP_REASONS.INACTIVITY
    }
    if (CHILD_STATUS.TERMINAL.includes(child.status)) reaped.push(child.childId)
  }
  return { checked: session.children.length, reaped }
}

export function cancelChild(session, childId, reason = DELEGATION_STOP_REASONS.CANCELLED) {
  const child = session?.children?.find((row) => row.childId === childId)
  if (!child) return { ok: false, reason: "unknown-child" }
  if (CHILD_STATUS.TERMINAL.includes(child.status)) {
    return { ok: true, alreadyTerminal: true, childId, status: child.status }
  }
  child.status = CHILD_STATUS.CANCELLED
  child.stopReason = reason
  session.counters.cancelled += 1
  return { ok: true, childId, status: child.status, stopReason: reason }
}

/** Terminate every non-terminal child. Guarantees no orphan is left behind. */
export function cancelAllChildren(session, reason = DELEGATION_STOP_REASONS.CANCELLED) {
  const cancelled = []
  for (const child of session?.children || []) {
    if (CHILD_STATUS.TERMINAL.includes(child.status)) continue
    const result = cancelChild(session, child.childId, reason)
    if (result.ok) cancelled.push(child.childId)
  }
  if (session) session.cancelled = true
  return { cancelled: cancelled.length, childIds: cancelled, noOrphans: cancelled.length === (session?.children || []).filter((c) => !CHILD_STATUS.TERMINAL.includes(c.status)).length }
}

/** Completion receipt. Partial output on timeout/failure is preserved by the caller. */
export function finalizeChild(session, childId, result = {}) {
  const child = session?.children?.find((row) => row.childId === childId)
  if (!child) return { ok: false, reason: "unknown-child" }
  const failed = Number(result.exitCode ?? 0) !== 0 || result.error
  child.status = failed ? CHILD_STATUS.FAILED : CHILD_STATUS.COMPLETED
  child.stopReason = result.stopReason || (failed ? DELEGATION_STOP_REASONS.CHILD_FAILED : DELEGATION_STOP_REASONS.CHILD_COMPLETED)
  child.finishedAt = Date.now()
  child.durationMs = child.finishedAt - child.startedAt
  child.receipt = {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    childId: child.childId,
    parentId: child.parentId,
    role: child.role,
    agent: child.agent,
    depth: child.depth,
    status: child.status,
    stopReason: child.stopReason,
    durationMs: child.durationMs,
    exitCode: Number(result.exitCode ?? (failed ? 1 : 0)),
    outputRef: result.outputRef || null,
    handoffRef: result.handoffRef || null,
    // Explicitly NOT a verdict: only the local verifier can produce PASS/FAIL.
    canProduceVerdict: false,
    permissionGrant: false,
    partialOutputPreserved: Boolean(result.outputRef),
    fingerprint: "child-receipt:sha256:" + hash([child.childId, child.status, child.stopReason, result.outputRef || ""]),
  }
  if (child.status === CHILD_STATUS.COMPLETED) session.counters.completed += 1
  else session.counters.failed += 1
  return { ok: true, child: { ...child }, receipt: child.receipt }
}

export function delegationSummary(session) {
  const children = session?.children || []
  const durations = children.filter((child) => Number.isFinite(child.durationMs)).map((child) => child.durationMs)
  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    sessionId: session?.sessionId || null,
    parentId: session?.parentId || null,
    depth: session?.depth ?? 0,
    hardMaxDepth: session?.hardMaxDepth ?? FABRIC_LIMITS.hardMaxDepth,
    maxActiveChildren: session?.maxActiveChildren ?? FABRIC_LIMITS.defaultActiveChildren,
    delegations: children.length,
    completed: children.filter((child) => child.status === CHILD_STATUS.COMPLETED).length,
    failed: children.filter((child) => child.status === CHILD_STATUS.FAILED).length,
    cancelled: children.filter((child) => child.status === CHILD_STATUS.CANCELLED).length,
    timedOut: children.filter((child) => child.status === CHILD_STATUS.TIMED_OUT).length,
    orphansRemaining: children.filter((child) => !CHILD_STATUS.TERMINAL.includes(child.status)).length,
    totalChildMs: durations.reduce((sum, value) => sum + value, 0),
    counters: session?.counters || null,
  }
}

export { CHILD_STATUS }
