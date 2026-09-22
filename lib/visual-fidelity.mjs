import { createHash } from "node:crypto"

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null }
function range(value, tolerance = 0) {
  if (Array.isArray(value) && value.length === 2) return [Number(value[0]), Number(value[1])]
  const n = finite(value)
  return n == null ? null : [n - tolerance, n + tolerance]
}

export function validateVisualSpec(spec = {}) {
  const errors = []
  if (!spec || typeof spec !== "object") errors.push("spec must be an object")
  const viewport = spec.viewport || {}
  if (!(finite(viewport.width) > 0) || !(finite(viewport.height) > 0)) errors.push("viewport width/height must be positive")
  const ids = new Set()
  for (const element of spec.elements || []) {
    if (!element?.id) errors.push("every element needs id")
    else if (ids.has(element.id)) errors.push("duplicate element id: " + element.id)
    else ids.add(element.id)
  }
  return { valid:errors.length===0, errors }
}

export function visualSpecDigest(spec) {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex")
}

export function compareGeometry(expected = {}, actual = {}, options = {}) {
  const tolerance = Math.max(0, Number(options.tolerance ?? 2))
  const checks = {}
  let pass = true
  for (const key of ["x","y","width","height"]) {
    const exp = range(expected[key], tolerance)
    const act = finite(actual[key])
    const ok = Boolean(exp && act != null && act >= exp[0] && act <= exp[1])
    checks[key] = { expected:exp, actual:act, pass:ok }
    if (!ok) pass = false
  }
  return { pass, checks }
}

export function createGeometryReceipt(spec = {}, observations = [], options = {}) {
  const validation = validateVisualSpec(spec)
  if (!validation.valid) throw Object.assign(new Error("Invalid visual spec"), { validation })
  const byId = new Map(observations.map((item) => [item.id, item]))
  const results = []
  for (const element of spec.elements || []) {
    const actual = byId.get(element.id)
    if (!actual) {
      results.push({ id:element.id, pass:false, error:"missing-observation" })
      continue
    }
    const expectedBox = element.box || {
      x: element.x, y: element.y, width: element.width, height: element.height,
    }
    results.push({ id:element.id, ...compareGeometry(expectedBox, actual.box || actual, options) })
  }
  return {
    schemaVersion:1,
    kind:"ues-visual-geometry-receipt",
    visualSpecDigest:visualSpecDigest(spec),
    viewport:spec.viewport,
    createdAt:new Date().toISOString(),
    verdict:results.every((item)=>item.pass) ? "PASS" : "FAIL",
    results,
  }
}

export function largestDiffRegion(regions = []) {
  return regions.map((r)=>({
    ...r,
    area:Math.max(0, Number(r.width||0))*Math.max(0, Number(r.height||0)),
    ratio:Number(r.ratio||0),
  })).sort((a,b)=> (b.ratio*b.area)-(a.ratio*a.area) || b.area-a.area)[0] || null
}

export function planVisualVerification(input = {}) {
  const hasReference = Boolean(input.referenceImage || input.visualSpec)
  return {
    schemaVersion:1,
    requireSemanticTree:true,
    requireGeometry:true,
    requireScreenshot:hasReference,
    requirePixelDiff:Boolean(input.referenceImage),
    viewports:Array.isArray(input.viewports) && input.viewports.length ? input.viewports : [input.viewport || "project-default"],
    maxRepairAttempts:Math.max(1, Math.min(5, Number(input.maxRepairAttempts || 3))),
    trustLevel:input.trustLevel || "user-provided",
  }
}
