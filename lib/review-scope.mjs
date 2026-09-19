import path from "node:path"
import { spawnSync } from "node:child_process"

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
}

function normalize(value) {
  return String(value || "").trim().replaceAll("\\", "/")
}

function riskForPath(file) {
  const value = file.toLowerCase()
  const reasons = []
  let score = 0

  const add = (points, reason) => {
    score += points
    reasons.push(reason)
  }

  if (/(migration|schema|prisma|database|sql)/.test(value)) add(3, "persistence/schema")
  if (/(auth|permission|security|token|session|credential|secret)/.test(value)) add(3, "auth/security")
  if (/(payment|billing|checkout|webhook|refund)/.test(value)) add(3, "payment")
  if (/(package\.json|package-lock\.json|pnpm-lock|yarn\.lock|pom\.xml|build\.gradle|\.csproj$)/.test(value)) add(2, "dependency/build")
  if (/(docker|deploy|workflow|\.github\/|terraform|k8s|kubernetes)/.test(value)) add(2, "delivery/infrastructure")
  if (/\.(env|pem|key)$/.test(value)) add(4, "sensitive-file")
  if (/(api|controller|route|handler|dto|contract|openapi)/.test(value)) add(1, "public/interface")
  if (/(test|spec|__tests__)/.test(value)) score = Math.max(0, score - 1)

  const level = score >= 5 ? "critical" : score >= 3 ? "high" : score >= 1 ? "medium" : "low"
  return { level, score, reasons }
}

export function classifyReviewFiles(files) {
  return files.map((file) => ({ path: normalize(file), risk: riskForPath(file) }))
}

function parseNameStatus(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t")
      const status = parts[0]
      const file = parts[parts.length - 1]
      return { status, path: normalize(file) }
    })
}

export function reviewScope(root = process.cwd(), base = null) {
  root = path.resolve(root)
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) {
    return { schemaVersion: 1, root, git: false, error: (inside.stderr || inside.stdout || "").trim() }
  }

  let committed = []
  let mergeBase = null
  if (base) {
    const merge = git(root, ["merge-base", base, "HEAD"])
    if (merge.status === 0) {
      mergeBase = merge.stdout.trim()
      const diff = git(root, ["diff", "--name-status", mergeBase + "..HEAD"])
      if (diff.status === 0) committed = parseNameStatus(diff.stdout)
    }
  }

  const work = git(root, ["status", "--porcelain=v1"])
  const workspace = work.status === 0
    ? work.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
        status: line.slice(0, 2).trim() || "??",
        path: normalize(line.slice(3).replace(/^.* -> /, "")),
      }))
    : []

  const byPath = new Map()
  for (const item of [...committed, ...workspace]) byPath.set(item.path, item)
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  const classified = classifyReviewFiles(files.map((item) => item.path))
  const riskMap = new Map(classified.map((item) => [item.path, item.risk]))

  const scoped = files.map((item) => ({ ...item, risk: riskMap.get(item.path) }))
  const maxScore = Math.max(0, ...scoped.map((item) => item.risk.score))
  const overallRisk = maxScore >= 5 ? "critical" : maxScore >= 3 ? "high" : maxScore >= 1 ? "medium" : "low"

  return {
    schemaVersion: 1,
    root,
    git: true,
    base,
    mergeBase,
    overallRisk,
    totalFiles: scoped.length,
    files: scoped,
    coverageRequired: scoped.map((item) => item.path),
  }
}
