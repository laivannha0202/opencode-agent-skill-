import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

function validPlanHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""))
}

export function planScopePaths(paths, planHash) {
  if (!validPlanHash(planHash)) throw new Error("plan scope requires a SHA-256 plan hash")
  const dir = path.join(paths.plans, planHash)
  return { dir, plan: path.join(dir, "PLAN.json"), metadata: path.join(dir, "SCOPE.json") }
}

export async function persistPlanScope(paths, planHash, plan, metadata = {}) {
  const scoped = planScopePaths(paths, planHash)
  await mkdir(scoped.dir, { recursive: true })
  await writeFile(scoped.plan, JSON.stringify(plan, null, 2) + "\n", "utf8")
  const record = {
    schemaVersion: 1,
    planHash,
    importedAt: metadata.importedAt || new Date().toISOString(),
    previousPlanHash: metadata.previousPlanHash || null,
    relativeDir: path.relative(paths.root, scoped.dir).replaceAll("\\", "/"),
  }
  await writeFile(scoped.metadata, JSON.stringify(record, null, 2) + "\n", "utf8")
  await writeFile(paths.activePlan, JSON.stringify(record, null, 2) + "\n", "utf8")
  return record
}

export async function readActivePlanScope(paths) {
  if (!existsSync(paths.activePlan)) return null
  try { return JSON.parse(await readFile(paths.activePlan, "utf8")) }
  catch { throw new Error("ACTIVE_PLAN.json is invalid; re-import the plan before execution") }
}

export async function assertActivePlanScope(paths, expectedPlanHash) {
  const active = await readActivePlanScope(paths)
  if (!active) return { legacy: true, planHash: expectedPlanHash || null }
  if (!validPlanHash(active.planHash)) throw new Error("ACTIVE_PLAN.json contains an invalid plan hash")
  if (expectedPlanHash && active.planHash !== expectedPlanHash) {
    throw new Error("active plan scope mismatch; re-import PLAN.json before executing tasks")
  }
  const scoped = planScopePaths(paths, active.planHash)
  if (!existsSync(scoped.plan) || !existsSync(scoped.metadata)) {
    throw new Error("active plan scope snapshot is incomplete; re-import PLAN.json")
  }
  return { ...active, legacy: false }
}
