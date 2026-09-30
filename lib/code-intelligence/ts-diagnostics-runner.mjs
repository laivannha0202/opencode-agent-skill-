// Out-of-process entry point for the deterministic TypeScript diagnostics
// fallback.
//
// This runs as a short-lived child process for one concrete reason: the managed
// language server communicates over this process's event loop. Evaluating a
// TypeScript program is synchronous, CPU-bound work, and running it inline
// would stall stdout parsing for the language server itself -- the exact
// session the caller is trying to keep healthy. Isolating it keeps tier A's
// session responsive while tier B does its work, and gives the evaluation a
// real hard timeout instead of a cooperative one.
//
// Protocol: a JSON request on argv[2], a single JSON response on stdout. The
// child never writes to the workspace and never emits compiler output.

import { computeTypeScriptDiagnostics } from "./ts-diagnostics.mjs"

function respond(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload))
  process.exitCode = code
}

let request = null
try {
  request = JSON.parse(process.argv[2] || "{}")
} catch {
  respond({
    complete: false,
    reason: "fallback-bad-request",
    diagnostics: [],
    source: "typescript-compiler-api",
    evidenceFingerprint: null,
    compilerVersion: null,
    environmentDiagnosticCount: 0,
    error: "fallback request was not valid JSON",
  })
}

if (request) {
  try {
    respond(computeTypeScriptDiagnostics(request))
  } catch (error) {
    respond({
      complete: false,
      reason: "fallback-crashed",
      diagnostics: [],
      source: "typescript-compiler-api",
      evidenceFingerprint: null,
      compilerVersion: null,
      environmentDiagnosticCount: 0,
      error: String(error instanceof Error ? error.message : error).slice(0, 400),
    })
  }
}
