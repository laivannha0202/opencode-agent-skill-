import { spawnSync } from "node:child_process"

export function detectHermes() {
  const run = spawnSync("hermes", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: process.platform === "win32",
  })
  const output = String(run.stdout || run.stderr || "").trim()
  return {
    available: run.status === 0,
    status: run.status,
    version: run.status === 0 ? output || "unknown" : null,
    error: run.status === 0 ? null : output || "Hermes CLI not found",
  }
}

export function buildHermesHandoff(contextPack, options = {}) {
  const payload = {
    schemaVersion: 1,
    source: "ues",
    target: "hermes-agent",
    createdAt: new Date().toISOString(),
    task: contextPack?.task || null,
    spec: contextPack?.spec || "",
    dependencyReports: contextPack?.dependencyReports || {},
    contextManifest: contextPack?.contextManifest || null,
    decisions: contextPack?.decisions || [],
    blockers: contextPack?.blockers || [],
    constraints: [
      "Implement only the approved task scope.",
      "Do not merge, push, publish or deploy.",
      "Return observable verification evidence.",
    ],
    metadata: {
      slug: contextPack?.slug || null,
      requestedBy: options.requestedBy || "ocskill",
    },
  }
  return {
    payload,
    markdown:
      "# UES to Hermes handoff\n\n" +
      "Task: " + (payload.task?.id || "unknown") + "\n\n" +
      "This packet is an optional interoperability handoff. UES remains the source of truth for PLAN/STATE/EVIDENCE.\n\n" +
      "JSON payload:\n" + JSON.stringify(payload, null, 2) + "\n",
  }
}
