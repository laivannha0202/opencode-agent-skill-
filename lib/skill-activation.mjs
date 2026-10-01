import { createHash } from "node:crypto"

function clean(value) { return String(value || "").trim() }
function clamp(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }

export function skillMetadataSurface(skills = [], options = {}) {
  const limit = clamp(options.limit, 12, 1, 48)
  const rows = (Array.isArray(skills) ? skills : [])
    .map((skill) => typeof skill === "string"
      ? { name: clean(skill), description: "" }
      : { name: clean(skill?.name), description: clean(skill?.description).slice(0, 280), costHint: skill?.costHint || null })
    .filter((skill) => skill.name)
    .slice(0, limit)
  const payload = { schemaVersion: 1, mode: "metadata-first", limit, skills: rows, fullSkillBodiesLoaded: false }
  return Object.freeze({ ...payload, id: "skill-surface:sha256:" + hash(payload) })
}

export function evaluateSkillActivation(cases = [], activations = []) {
  const expected = new Map((cases || []).map((row) => [String(row.id), new Set(row.expected || [])]))
  const actual = new Map((activations || []).map((row) => [String(row.id), new Set(row.selected || [])]))
  let tp = 0, fp = 0, fn = 0
  const rows = []
  for (const [id, wanted] of expected) {
    const got = actual.get(id) || new Set()
    const truePositives = [...got].filter((name) => wanted.has(name))
    const falsePositives = [...got].filter((name) => !wanted.has(name))
    const falseNegatives = [...wanted].filter((name) => !got.has(name))
    tp += truePositives.length; fp += falsePositives.length; fn += falseNegatives.length
    rows.push({ id, truePositives, falsePositives, falseNegatives })
  }
  const precision = tp + fp ? tp / (tp + fp) : 1
  const recall = tp + fn ? tp / (tp + fn) : 1
  return { schemaVersion: 1, cases: rows.length, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, rows }
}

export function skillDietDecision(stats = {}, options = {}) {
  const minCases = clamp(options.minCases, 8, 1, 10000)
  const cases = Number(stats.cases || 0)
  if (cases < minCases) return { action: "measure", reason: "insufficient-activation-evidence" }
  const precision = Number(stats.precision ?? 0)
  const recall = Number(stats.recall ?? 0)
  if (precision >= 0.9 && recall >= 0.85) return { action: "keep", reason: "measured-activation-quality" }
  if (precision < 0.55 && recall < 0.55) return { action: "deprecate-candidate", reason: "low-measured-value-review-required" }
  return { action: "refine", reason: "activation-quality-needs-improvement" }
}
