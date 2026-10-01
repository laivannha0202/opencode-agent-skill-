const BEHAVIORAL_TEST_COMMAND = [
  /(?:^|\s)(?:node|bun)\s+--test(?:\s|$)/i,
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$|:)/i,
  /(?:^|\s)(?:npx\s+)?(?:jest|vitest|pytest)(?:\s|$)/i,
  /(?:^|\s)go\s+test(?:\s|$)/i,
  /(?:^|\s)cargo\s+test(?:\s|$)/i,
  /(?:^|\s)dotnet\s+test(?:\s|$)/i,
  /(?:^|\s)(?:mvn|mvnw|gradle|gradlew|\.\/gradlew|gradlew\.bat)\b[^\n]*\btest\b/i,
]

function commandText(row = {}) {
  const receipt = row?.receipt || {}
  return [receipt.command, ...(Array.isArray(receipt.args) ? receipt.args : [])].filter(Boolean).join(" ").trim()
}

function finishedAtMs(row = {}) {
  const value = Date.parse(row?.finishedAt || row?.receipt?.finishedAt || "")
  return Number.isFinite(value) ? value : null
}

export function isBehavioralVerificationReceipt(row = {}) {
  const receipt = row?.receipt || {}
  if (receipt.passed !== true || Number(receipt.exitCode) !== 0) return false
  const command = commandText(row)
  return Boolean(command) && BEHAVIORAL_TEST_COMMAND.some((pattern) => pattern.test(command))
}

export function evaluateFastVerificationGate(input = {}) {
  const policy = input.policy || {}
  const implementation = input.implementation || {}
  const receipts = Array.isArray(input.receipts) ? input.receipts : []
  const attemptStartedAtMs = Number(input.attemptStartedAtMs || 0)
  const eligible =
    policy.executionProfile === "fast" &&
    policy.singleFileBounded === true &&
    policy.risk === "low" &&
    input.visualRequired !== true
  const implementationOk =
    Number(implementation.exitCode) === 0 &&
    String(implementation.stopReason || "").toLowerCase() !== "error"
  const verificationText = String(implementation?.report?.sections?.verification || "").trim()
  const implementationReportedVerification =
    Boolean(verificationText) &&
    !/(?:not\s+run|not\s+available|skipped|unverified|no\s+(?:tests?|checks?)\s+(?:run|available))/i.test(verificationText)
  const staticEvidence = input.staticEvidence && typeof input.staticEvidence === "object"
    ? input.staticEvidence
    : { required: false, complete: true, errorCount: 0, reason: "not-required" }
  const staticRequired = staticEvidence.required === true
  const staticComplete = staticEvidence.complete === true
  const staticErrorCount = Math.max(0, Number(staticEvidence.errorCount || 0))
  const staticOk = !staticRequired || (staticComplete && staticErrorCount === 0)

  const behavioralReceipts = receipts
    .filter((row) => {
      const finished = finishedAtMs(row)
      return isBehavioralVerificationReceipt(row) &&
        (attemptStartedAtMs <= 0 || (finished != null && finished >= attemptStartedAtMs))
    })
    .map((row) => ({
      command: commandText(row),
      finishedAt: row?.finishedAt || row?.receipt?.finishedAt || null,
      receiptId: row?.receipt?.id || null,
    }))
  let reason = "fresh-behavioral-evidence"
  if (!eligible) reason = "not-fast-bounded"
  else if (!implementationOk) reason = "implementation-not-clean"
  else if (!implementationReportedVerification) reason = "implementation-did-not-report-verification"
  else if (staticRequired && !staticComplete) reason = "static-evidence-incomplete"
  else if (staticRequired && staticErrorCount > 0) reason = "static-evidence-errors"
  else if (!behavioralReceipts.length) reason = "no-fresh-behavioral-receipt"
  return {
    schemaVersion: 2,
    eligible,
    passed: eligible && implementationOk && implementationReportedVerification && staticOk && behavioralReceipts.length > 0,
    reason,
    staticEvidence: {
      required: staticRequired,
      complete: staticComplete,
      errorCount: staticErrorCount,
      warningCount: Math.max(0, Number(staticEvidence.warningCount || 0)),
      file: staticEvidence.file || null,
      source: staticEvidence.source || null,
      fingerprint: staticEvidence.fingerprint || null,
      reason: staticEvidence.reason || null,
    },
    behavioralReceiptCount: behavioralReceipts.length,
    behavioralReceipts,
  }
}
