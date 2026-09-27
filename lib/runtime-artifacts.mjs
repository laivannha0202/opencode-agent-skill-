export const UES_RUNTIME_DIRS = Object.freeze([
  ".ues-cache",
  ".ues-traces",
  ".ues-work",
  ".ues-learning",
  ".ues-dashboard",
  ".ues-sandboxes",
  ".ues-memory",
  ".ues-evals",
  ".ues-services",
])

export function normalizeRuntimePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
}

export function isUesRuntimeArtifactPath(value) {
  const normalized = normalizeRuntimePath(value)
  if (!normalized) return false
  return UES_RUNTIME_DIRS.some(
    (dir) => normalized === dir || normalized.startsWith(dir + "/"),
  )
}

export function sourceFacingPaths(values = []) {
  return [...new Set(
    (values || [])
      .map(normalizeRuntimePath)
      .filter(Boolean)
      .filter((value) => !isUesRuntimeArtifactPath(value)),
  )]
}

export function sourceGitPathspecs() {
  return [
    ".",
    ...UES_RUNTIME_DIRS.map((dir) => ":(exclude)" + dir + "/**"),
  ]
}
