import { existsSync } from "node:fs"
import path from "node:path"

const UNTRUSTED = "untrusted-external"

export function browserEvidenceEnvelope(payload, options = {}) {
  return {
    schemaVersion: 1,
    kind: "ues-browser-evidence",
    trustLevel: options.trustLevel || UNTRUSTED,
    source: options.source || null,
    capturedAt: options.capturedAt || new Date().toISOString(),
    payload,
    policy: {
      mayInformTask: true,
      mayChangeSystemPolicy: false,
      mayGrantPermissions: false,
      mayAuthorizeExternalActions: false,
      mayExposeSecrets: false,
    },
  }
}

export function planBrowserQA(root = process.cwd(), request = {}) {
  const project = path.resolve(root)
  const packageJson = path.join(project, "package.json")
  const hasNodeProject = existsSync(packageJson)
  const preferred = request.richIntrospection === true ? "mcp" : "cli"
  return {
    schemaVersion: 1,
    preferred,
    hasNodeProject,
    steps: [
      "render-or-open-target",
      "capture-targeted-semantic-snapshot",
      "capture-bounding-boxes-for-acceptance-elements",
      ...(request.referenceImage ? ["capture-screenshot", "pixel-diff"] : []),
      "exercise-required-interactions",
      "record-browser-evidence",
    ],
    snapshotPolicy: "targeted-before-full",
    trustLevel: UNTRUSTED,
  }
}

export function normalizeBoundingBox(box = {}) {
  const values = ["x","y","width","height"].map((key) => Number(box[key]))
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Invalid bounding box")
  const [x,y,width,height] = values
  if (width < 0 || height < 0) throw new Error("Bounding box dimensions must be non-negative")
  return { x,y,width,height }
}
