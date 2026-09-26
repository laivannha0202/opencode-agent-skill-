function text(value) {
  return String(value ?? "").trim()
}

function reportSections(run) {
  const sections = run?.report?.sections
  return sections && typeof sections === "object" ? sections : {}
}

function passRun(run) {
  return Boolean(run && Number(run.exitCode) === 0 && run.verdict === "PASS")
}

function benignEmptySection(value) {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[`*_#]/g, "")
    .replace(/[.!:;]+$/g, "")
    .trim()
  return !normalized || /^(?:none(?: observed| found| remaining)?|n\/a|na|nil|0|no failures?(?: observed| found| remaining)?|no unresolved gaps?(?: observed| found| remaining)?|no gaps?(?: observed| found| remaining)?|not applicable)$/.test(normalized)
}

function receiptPassed(row = {}) {
  const receipt = row?.receipt || row
  return Boolean(receipt?.passed === true && Number(receipt?.exitCode) === 0)
}

export function auditCompletion(input = {}) {
  const failures = []
  const warnings = []
  const verification = input.verification || null
  const integration = input.integration || null
  const visual = input.visual || null
  const requireIntegration = input.requireIntegration === true
  const requireVisual = input.requireVisual === true
  const receipts = Array.isArray(input.behavioralReceipts) ? input.behavioralReceipts : []

  if (!passRun(verification)) failures.push("primary-verification-not-pass")
  if (requireIntegration && !passRun(integration)) failures.push("integration-verification-not-pass")
  if (requireVisual && !passRun(visual)) failures.push("visual-verification-not-pass")

  const sections = reportSections(verification)
  for (const key of ["checks-run", "acceptance-criteria-proven", "completion-evidence"]) {
    if (!text(sections[key])) failures.push(`missing-report-section:${key}`)
  }
  if (Object.hasOwn(sections, "failures") && !benignEmptySection(sections.failures)) failures.push("verification-reports-failures")
  if (Object.hasOwn(sections, "unresolved-gaps") && !benignEmptySection(sections["unresolved-gaps"])) failures.push("verification-reports-unresolved-gaps")
  if (Object.hasOwn(sections, "checks-not-run") && !benignEmptySection(sections["checks-not-run"])) warnings.push("verification-reports-checks-not-run")

  const snapshot = input.workspaceSnapshot || null
  if (snapshot) {
    if (snapshot.cacheable === true && !text(snapshot.fingerprint)) failures.push("workspace-fingerprint-missing")
    if (Array.isArray(snapshot.changedFiles) && snapshot.changedFiles.length === 0) warnings.push("workspace-has-no-detected-changes")
  } else {
    warnings.push("workspace-snapshot-unavailable")
  }

  const passingReceipts = receipts.filter(receiptPassed)
  if (input.requireBehavioralReceipt === true && passingReceipts.length === 0) failures.push("fresh-behavioral-receipt-missing")
  else if (passingReceipts.length === 0) warnings.push("no-fresh-behavioral-receipt-attached")

  const verifierOutput = text(verification?.output)
  if (verification?.report?.valid === false) failures.push("verification-report-invalid")
  if (verification?.report?.verdict && verification.report.verdict !== "PASS") failures.push("verification-report-verdict-mismatch")
  if (/UES_VERDICT:\s*FAIL/i.test(verifierOutput)) failures.push("verifier-output-contains-fail-verdict")

  return {
    schemaVersion: 1,
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
    evidence: {
      primary: passRun(verification),
      integration: requireIntegration ? passRun(integration) : null,
      visual: requireVisual ? passRun(visual) : null,
      reportSections: Object.keys(sections).sort(),
      passingReceiptCount: passingReceipts.length,
      workspaceFingerprint: snapshot?.fingerprint || null,
      changedFiles: Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles.slice(0, 200) : [],
    },
  }
}
