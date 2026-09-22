function uniq(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))]
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function normalizeBox(item = {}) {
  const box = item.box && typeof item.box === "object" ? item.box : item
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x,y,width,height].every(Number.isFinite)) return null
  return {
    id: String(item.id || item.name || "").trim() || null,
    role: item.role || null,
    x, y, width, height,
    right: x + width,
    bottom: y + height,
  }
}

function containsBox(a, b) {
  return a.x <= b.x && a.y <= b.y && a.right >= b.right && a.bottom >= b.bottom
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
  return width * height
}

export function inspectResponsiveLayout(items = [], viewport = {}, options = {}) {
  const width = Math.max(1, Number(viewport.width || 0))
  const height = Math.max(1, Number(viewport.height || 0))
  const boxes = items.map(normalizeBox).filter(Boolean)
  const issues = []
  const minTouch = Math.max(1, Number(options.minTouchTarget || 44))
  const touchRoles = new Set(["button","link","checkbox","radio","switch","tab","menuitem"])

  for (const box of boxes) {
    if (box.x < 0 || box.y < 0 || box.right > width || box.bottom > height) {
      issues.push({
        kind: "viewport-overflow",
        id: box.id,
        box,
        viewport: { width, height },
      })
    }
    if (touchRoles.has(String(box.role || "").toLowerCase()) && (box.width < minTouch || box.height < minTouch)) {
      issues.push({
        kind: "small-touch-target",
        id: box.id,
        role: box.role,
        actual: { width: box.width, height: box.height },
        minimum: minTouch,
      })
    }
  }

  const maxPairChecks = Math.max(0, Math.min(10000, Number(options.maxPairChecks || 3000)))
  let checks = 0
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length && checks < maxPairChecks; j += 1) {
      checks += 1
      const a = boxes[i]
      const b = boxes[j]
      if (containsBox(a,b) || containsBox(b,a)) continue
      const area = intersectionArea(a,b)
      if (!area) continue
      const smaller = Math.max(1, Math.min(a.width*a.height, b.width*b.height))
      const ratio = area / smaller
      if (ratio >= Number(options.overlapRatio ?? 0.15)) {
        issues.push({
          kind: "element-overlap",
          a: a.id,
          b: b.id,
          intersectionArea: area,
          smallerElementRatio: round(ratio),
        })
      }
    }
  }

  return {
    schemaVersion: 1,
    viewport: { width, height },
    elementCount: boxes.length,
    pairChecks: checks,
    verdict: issues.length ? "FAIL" : "PASS",
    issues,
  }
}

function normalizeCssValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ")
}

export function extractDesignTokens(css = "") {
  const source = String(css || "")
  const variables = {}
  for (const match of source.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)\s*;/g)) {
    variables["--" + match[1]] = normalizeCssValue(match[2])
  }

  const colors = uniq([
    ...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...source.matchAll(/\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g),
  ].map((match) => match[0].toLowerCase())).slice(0, 128)

  const lengths = uniq([...source.matchAll(/-?\d*\.?\d+(?:px|rem|em)\b/g)].map((m)=>m[0]))
  const px = lengths.filter((value)=>value.endsWith("px")).map((value)=>Number.parseFloat(value)).filter((value)=>Number.isFinite(value) && value >= 0)
  const radii = uniq([...source.matchAll(/border-radius\s*:\s*([^;}{]+)/g)].map((m)=>normalizeCssValue(m[1]))).slice(0,64)
  const fontSizes = uniq([...source.matchAll(/font-size\s*:\s*([^;}{]+)/g)].map((m)=>normalizeCssValue(m[1]))).slice(0,64)
  const shadows = uniq([...source.matchAll(/box-shadow\s*:\s*([^;}{]+)/g)].map((m)=>normalizeCssValue(m[1]))).slice(0,64)

  const spacingCandidates = uniq(px.filter((value)=>value <= 128).sort((a,b)=>a-b)).slice(0,32)

  return {
    schemaVersion: 1,
    variables,
    colors,
    spacingCandidates,
    radii,
    fontSizes,
    shadows,
    stats: {
      variableCount: Object.keys(variables).length,
      colorCount: colors.length,
      lengthCount: lengths.length,
    },
  }
}

export function designTokenEvidence(tokens = {}) {
  const variableEntries = Object.entries(tokens.variables || {})
  return {
    schemaVersion: 1,
    summary: {
      variables: variableEntries.slice(0,40),
      colors: (tokens.colors || []).slice(0,24),
      spacingCandidates: (tokens.spacingCandidates || []).slice(0,20),
      radii: (tokens.radii || []).slice(0,16),
      fontSizes: (tokens.fontSizes || []).slice(0,16),
      shadows: (tokens.shadows || []).slice(0,12),
    },
    stats: tokens.stats || {},
  }
}
