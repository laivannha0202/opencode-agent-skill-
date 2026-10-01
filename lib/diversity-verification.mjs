import { createHash } from "node:crypto"

const RISK_RANK = Object.freeze({ low: 0, medium: 1, standard: 1, high: 2, critical: 3 })

function cleanModel(value) { return String(value || "").trim() }
function cleanRisk(value) { return String(value || "medium").trim().toLowerCase() }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }

export function diversityVerificationPolicy(input = {}) {
  const risk = cleanRisk(input.risk)
  const rank = RISK_RANK[risk] ?? 1
  const executorModel = cleanModel(input.executorModel)
  const candidates = [...new Set((input.alternateModels || []).map(cleanModel).filter(Boolean))]
  const alternateModel = candidates.find((model) => model !== executorModel) || null
  const crossModelPreferred = rank >= 2
  const crossModelRequired = rank >= 3 && input.requireCrossModelForCritical === true
  const selectedVerifierModel = crossModelPreferred && alternateModel ? alternateModel : executorModel || null
  const payload = {
    schemaVersion: 1,
    risk,
    crossModelPreferred,
    crossModelRequired,
    selectedVerifierModel,
    executorModel: executorModel || null,
    independentContextRequired: rank >= 1,
    hideExecutorRationale: true,
    differentToolSurfacePreferred: rank >= 2,
    fallback: alternateModel ? null : "fresh-context-same-model",
    extraIntegrationVerification: rank >= 2,
    visualVerificationWhenRequired: true,
  }
  return Object.freeze({ ...payload, id: "verification-diversity:sha256:" + hash(payload) })
}
