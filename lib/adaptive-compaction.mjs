import { summarizeCompactionRecall } from "./compaction-recall.mjs"

const CACHE = new Map()
const DEFAULT_TTL_MS = 30_000

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)))
}

function familyCandidates(hint) {
  const value = String(hint || "").toLowerCase()
  if (/(pytest|python.*test)/.test(value)) return ["pytest", "test", "verification-test"]
  if (/(jest|vitest|npm test|pnpm test|yarn test|node --test)/.test(value)) return ["test", "verification-test"]
  if (/(eslint|lint|ruff|flake8|pylint|clippy)/.test(value)) return ["eslint", "lint", "python-lint"]
  if (/(tsc|typecheck|typescript)/.test(value)) return ["tsc", "build"]
  if (/(git diff)/.test(value)) return ["git-diff", "git"]
  if (/(git status)/.test(value)) return ["git-status", "git"]
  if (/(git log)/.test(value)) return ["git-log", "git"]
  if (/(rg|ripgrep|grep|find)/.test(value)) return ["rg", "search", "signal"]
  if (/(tree|ls\b)/.test(value)) return ["tree", "signal"]
  if (/(npm install|pnpm install|yarn install)/.test(value)) return ["package-install", "signal"]
  return ["signal", "generic"]
}

export function adaptiveCompactionBudgetFromSummary(summary = {}, hint = "", baseMaxChars = 24 * 1024, options = {}) {
  const base = clamp(baseMaxChars, 8 * 1024, 256 * 1024)
  const minSamples = Math.max(1, Math.trunc(Number(options.minSamples || 4)))
  const byReducer = summary?.byReducer || {}
  let selectedFamily = null
  let bucket = null
  for (const family of familyCandidates(hint)) {
    if (!byReducer[family]) continue
    if (!bucket || Number(byReducer[family].compacted || 0) > Number(bucket.compacted || 0)) {
      selectedFamily = family
      bucket = byReducer[family]
    }
  }
  const samples = Number(bucket?.compacted || 0)
  const recallRate = samples ? Number(bucket?.recallDemandRate || 0) : null
  let multiplier = 1
  let reason = "insufficient-recall-history"
  if (samples >= minSamples) {
    if (recallRate >= 0.35) {
      multiplier = 1.5
      reason = "high-recall-demand-preserve-more"
    } else if (recallRate >= 0.20) {
      multiplier = 1.25
      reason = "moderate-recall-demand-preserve-more"
    } else if (recallRate <= 0.05) {
      multiplier = 0.75
      reason = "low-recall-demand-compact-more"
    } else {
      reason = "recall-demand-balanced"
    }
  }
  return {
    schemaVersion: 1,
    family: selectedFamily,
    samples,
    recallRate,
    baseMaxChars: base,
    maxChars: clamp(base * multiplier, 8 * 1024, 128 * 1024),
    multiplier,
    reason,
  }
}

export async function adaptiveCompactionBudget(root, hint, baseMaxChars, options = {}) {
  const key = String(root || process.cwd())
  const ttlMs = clamp(options.ttlMs || DEFAULT_TTL_MS, 1000, 5 * 60_000)
  const now = Date.now()
  let cached = CACHE.get(key)
  if (!cached || now - cached.at > ttlMs) {
    const summary = await summarizeCompactionRecall(key, { limit: 2000 }).catch(() => ({ byReducer: {} }))
    cached = { at: now, summary }
    CACHE.set(key, cached)
  }
  return adaptiveCompactionBudgetFromSummary(cached.summary, hint, baseMaxChars, options)
}

export function clearAdaptiveCompactionCache(root) {
  if (root == null) CACHE.clear()
  else CACHE.delete(String(root))
}
