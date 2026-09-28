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

function normalizeSection(value) {
  return text(value)
    .toLowerCase()
    .replace(/[`*_#]/g, "")
    .replace(/[.!:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function benignEmptySection(value) {
  const normalized = normalizeSection(value)
  return !normalized || /^(?:none(?: observed| found| remaining)?|n\/a|na|nil|0|no failures?(?: observed| found| remaining)?|no unresolved gaps?(?: observed| found| remaining)?|no gaps?(?: observed| found| remaining)?|not applicable|không có|không có gì|không có lỗi|không phát hiện lỗi|không còn khoảng trống|không có khoảng trống)$/.test(normalized)
}

function benignFailureSection(value) {
  const normalized = normalizeSection(value)
  return benignEmptySection(normalized) ||
    /^(?:không có|không phát hiện) .{0,120}(?:lỗi|thất bại)(?: nào)?$/.test(normalized)
}

function outOfScopeGapOnly(value) {
  const normalized = normalizeSection(value)
  if (benignEmptySection(normalized)) return true
  return /(?:not requested|outside (?:the )?scope|out of scope|not required|không có yêu cầu|không được yêu cầu|ngoài phạm vi|không thuộc phạm vi)/.test(normalized)
}

function receiptPassed(row = {}) {
  const receipt = row?.receipt || row
  return Boolean(receipt?.passed === true && Number(receipt?.exitCode) === 0)
}

function claimEvidenceStatus(value) {
  const lines = text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const counts = { verified: 0, inferred: 0, unknown: 0 }
  for (const line of lines) {
    if (/^(?:[-*]\s*)?VERIFIED\s*:/i.test(line)) counts.verified += 1
    else if (/^(?:[-*]\s*)?INFERRED\s*:/i.test(line)) counts.inferred += 1
    else if (/^(?:[-*]\s*)?UNKNOWN\s*:/i.test(line)) counts.unknown += 1
  }
  return counts
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
  if (Object.hasOwn(sections, "failures") && !benignFailureSection(sections.failures)) failures.push("verification-reports-failures")
  if (Object.hasOwn(sections, "unresolved-gaps") && !benignEmptySection(sections["unresolved-gaps"])) {
    if (outOfScopeGapOnly(sections["unresolved-gaps"])) warnings.push("verification-reports-out-of-scope-gap")
    else failures.push("verification-reports-unresolved-gaps")
  }
  if (Object.hasOwn(sections, "checks-not-run") && !benignEmptySection(sections["checks-not-run"])) warnings.push("verification-reports-checks-not-run")

  const claimStatus = claimEvidenceStatus(sections["acceptance-criteria-proven"])
  if (claimStatus.inferred > 0) failures.push("acceptance-criteria-inferred-not-proven")
  if (claimStatus.unknown > 0) failures.push("acceptance-criteria-unknown-not-proven")

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
      claimEvidenceStatus: claimStatus,
      workspaceFingerprint: snapshot?.fingerprint || null,
      changedFiles: Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles.slice(0, 200) : [],
    },
  }
}
