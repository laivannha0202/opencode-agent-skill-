function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function range(value, tolerance = 0) {
  if (Array.isArray(value) && value.length >= 2) return [number(value[0]), number(value[1])]
  const exact = number(value)
  return [exact - tolerance, exact + tolerance]
}

function within(actual, expected, tolerance) {
  const [min, max] = range(expected, tolerance)
  return actual >= Math.min(min, max) && actual <= Math.max(min, max)
}

function normalizeElement(item = {}) {
  return {
    id: String(item.id || "").trim(),
    role: item.role || null,
    region: item.region || null,
    expected: {
      ...(item.expected || {}),
      ...(item.x !== undefined ? { x: item.x } : {}),
      ...(item.y !== undefined ? { y: item.y } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
    },
    tolerance: {
      position: number(item.tolerance?.position, 8),
      size: number(item.tolerance?.size, 8),
    },
    required: item.required !== false,
  }
}

export function normalizeVisualSpec(spec = {}) {
  const viewport = {
    width: Math.max(1, number(spec.viewport?.width, 1440)),
    height: Math.max(1, number(spec.viewport?.height, 900)),
    deviceScaleFactor: Math.max(0.1, number(spec.viewport?.deviceScaleFactor, 1)),
  }
  return {
    schemaVersion: 1,
    name: spec.name || null,
    viewport,
    elements: (spec.elements || []).map(normalizeElement).filter((item) => item.id),
    regions: Array.isArray(spec.regions) ? spec.regions : [],
    tokens: spec.tokens || {},
    metadata: spec.metadata || {},
  }
}

export function validateVisualSpec(spec = {}) {
  const normalized = normalizeVisualSpec(spec)
  const errors = []
  const ids = new Set()
  for (const item of normalized.elements) {
    if (ids.has(item.id)) errors.push("duplicate element id: " + item.id)
    ids.add(item.id)
    for (const key of ["x", "y", "width", "height"]) {
      if (item.expected[key] === undefined) continue
      const values = Array.isArray(item.expected[key]) ? item.expected[key] : [item.expected[key]]
      if (values.some((value) => !Number.isFinite(Number(value)))) errors.push(item.id + ": invalid " + key)
    }
  }
  return { valid: errors.length === 0, errors, spec: normalized }
}

function actualMap(actual = []) {
  const values = Array.isArray(actual) ? actual : Object.values(actual || {})
  return new Map(values.filter((item) => item?.id).map((item) => [String(item.id), item]))
}

export function createGeometryReceipt(specInput, actualInput, options = {}) {
  const checked = validateVisualSpec(specInput)
  if (!checked.valid) throw new Error("Invalid visual spec: " + checked.errors.join("; "))
  const actual = actualMap(actualInput)
  const elements = []
  let failed = 0

  for (const expected of checked.spec.elements) {
    const found = actual.get(expected.id)
    if (!found) {
      const pass = !expected.required
      if (!pass) failed += 1
      elements.push({ id: expected.id, verdict: pass ? "PASS" : "FAIL", reason: "missing", expected: expected.expected, actual: null })
      continue
    }

    const failures = []
    const checks = {}
    for (const key of ["x", "y"]) {
      if (expected.expected[key] === undefined) continue
      const ok = within(number(found[key]), expected.expected[key], expected.tolerance.position)
      checks[key] = ok
      if (!ok) failures.push(key)
    }
    for (const key of ["width", "height"]) {
      if (expected.expected[key] === undefined) continue
      const ok = within(number(found[key]), expected.expected[key], expected.tolerance.size)
      checks[key] = ok
      if (!ok) failures.push(key)
    }
    const pass = failures.length === 0
    if (!pass) failed += 1
    elements.push({
      id: expected.id,
      verdict: pass ? "PASS" : "FAIL",
      failures,
      checks,
      expected: expected.expected,
      actual: {
        x: number(found.x),
        y: number(found.y),
        width: number(found.width),
        height: number(found.height),
      },
    })
  }

  return {
    schemaVersion: 1,
    kind: "visual-geometry",
    verdict: failed === 0 ? "PASS" : "FAIL",
    viewport: checked.spec.viewport,
    total: elements.length,
    passed: elements.length - failed,
    failed,
    elements,
    generatedAt: options.generatedAt || new Date().toISOString(),
  }
}

export function buildVisualRepairPlan(receipt, pixelDiff = null) {
  const failedElements = (receipt?.elements || []).filter((item) => item.verdict !== "PASS")
  return {
    schemaVersion: 1,
    action: failedElements.length || (pixelDiff && pixelDiff.differentPixels > 0) ? "repair" : "accept",
    failedElementIDs: failedElements.map((item) => item.id),
    geometryFailures: failedElements.map((item) => ({ id: item.id, failures: item.failures || [item.reason] })),
    pixelRegion: pixelDiff?.bounds || null,
    directives: [
      ...(failedElements.length ? ["edit only the owning component/style for failed geometry unless evidence shows a shared token defect"] : []),
      ...(pixelDiff?.bounds ? ["inspect and, if vision is available, crop only the largest changed pixel region before another edit"] : []),
      "re-render the affected viewport and produce a fresh receipt before declaring success",
    ],
  }
}

export function responsiveViewportMatrix(input = null) {
  if (Array.isArray(input) && input.length) return input
  return [
    { id: "mobile", width: 390, height: 844 },
    { id: "tablet", width: 768, height: 1024 },
    { id: "desktop", width: 1440, height: 900 },
    { id: "wide", width: 1920, height: 1080 },
  ]
}
