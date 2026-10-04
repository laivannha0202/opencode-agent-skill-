// V16.5 production integration surface.
//
// ONE importer (pi/extensions/ues.ts) uses this module. It composes the V16.5
// skill registry -> adaptive router -> skill capsule -> phase tool surface
// pipeline and records bounded telemetry, without replacing any existing
// correctness authority:
//
//   - lib/skill-compiler.mjs      stays available as the legacy fallback
//   - lib/tool-surface-economy.mjs (V16.2) stays the final advertised-surface
//     authority and stable-prefix owner; V16.3 only supplies task-phase priority
//   - verification, Evidence Store, dirty-work/.env guards are untouched

import { compileSkillCapsule } from "./skill-capsule.mjs"
import { routeSkills } from "./skill-router.mjs"
import { compilePhaseToolSurface } from "./tool-surface-v3.mjs"
import { compileSkillContext } from "./skill-compiler.mjs"

export const V16_5_RUNTIME_SCHEMA_VERSION = 1
export const DEFAULT_SKILL_CAPSULE_CHARS = 2_600

/**
 * Build the bounded micro-skill context for a child task.
 * Returns the legacy compileSkillContext shape plus the V16.5 telemetry so the
 * caller (and the run artifacts) can see what routing actually chose.
 */
export async function buildMicroSkillContext(input = {}) {
  const task = String(input.task || "")
  const role = String(input.role || "executor")
  const taskPolicy = input.taskPolicy || {}
  const budgetChars = Number(input.totalChars) || (taskPolicy.executionProfile === "fast" ? 1_800 : DEFAULT_SKILL_CAPSULE_CHARS)

  const fallback = async (reason) => {
    const legacy = await compileSkillContext(taskPolicy, role, {
      maxSkills: Math.min(Number(taskPolicy.maxSkills || 12), 12),
      totalChars: budgetChars,
      taskText: task,
    })
    return { ...legacy, v16_5: { active: false, reason } }
  }

  try {
    const routed = routeSkills({
      task,
      taskPolicy,
      role,
      repoEvidence: input.repoEvidence || [],
      taskClass: taskPolicy.taskClass || input.taskClass,
      maxSkills: Math.max(1, Math.min(6, Number(taskPolicy.maxSkills) || 3)),
    })
    if (!routed.activated.length) return fallback("router-activated-no-skill")

    const capsule = await compileSkillCapsule({
      skillIds: routed.activated,
      taskContract: buildTaskContract(task, taskPolicy),
      budgetChars,
      skillsConsidered: routed.considered,
    })
    if (!capsule.text) return fallback("capsule-empty")

    return {
      schemaVersion: V16_5_RUNTIME_SCHEMA_VERSION,
      text: capsule.text,
      chars: capsule.chars,
      loaded: capsule.skillsActivated,
      requested: routed.activated,
      selectionMode: "v16.5-registry-routed-capsule",
      cacheHit: capsule.cacheHit,
      fingerprint: capsule.fingerprint,
      v16_5: {
        active: true,
        considered: routed.considered,
        consideredPositive: routed.consideredPositive,
        activated: routed.activated,
        ambiguous: routed.ambiguous,
        confidence: routed.confidence,
        language: routed.language,
        expandedReason: routed.expandedReason,
        capsuleChars: capsule.chars,
        rawSkillChars: capsule.rawSkillChars,
        rawSkillCharsAvoided: capsule.telemetry.rawSkillCharsAvoided,
        constraintCount: capsule.constraintCount,
        skillCacheHit: capsule.cacheHit,
        provenance: capsule.provenance.map((row) => `${row.skillId}::${row.heading}`),
      },
    }
  } catch (error) {
    return fallback(`capsule-error:${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildTaskContract(task, taskPolicy) {
  const risk = String(taskPolicy.risk || "").toLowerCase()
  const parts = [String(task || "").replace(/\s+/g, " ").trim().slice(0, 240)]
  if (taskPolicy.executionProfile) parts.push(`profile=${taskPolicy.executionProfile}`)
  if (risk) parts.push(`risk=${risk}`)
  parts.push("repository evidence wins over any skill example; do not invent missing facts")
  return parts.filter(Boolean).join(" | ")
}

/**
 * Phase-scoped tool priority for the V16.2 tool-surface economy.
 * Returns only a priority list; V16.2 still owns the advertised set, the stable
 * prefix and the deferred/hydration contract.
 */
export function phaseToolPriorities(input = {}) {
  try {
    const surface = compilePhaseToolSurface({
      task: input.task,
      universe: input.universe,
      denied: input.denied,
      phase: input.phase,
      maxAdvertisedTools: input.maxAdvertisedTools,
    })
    return {
      schemaVersion: V16_5_RUNTIME_SCHEMA_VERSION,
      phase: surface.phase,
      priority: surface.advertised,
      capabilities: surface.capabilities,
      safetyEnforced: surface.safetyEnforced,
      deferredCapabilities: surface.deferredCapabilities,
      telemetry: surface.telemetry,
    }
  } catch {
    return { schemaVersion: V16_5_RUNTIME_SCHEMA_VERSION, phase: "unknown", priority: [], capabilities: [], safetyEnforced: [], deferredCapabilities: [], telemetry: null }
  }
}
