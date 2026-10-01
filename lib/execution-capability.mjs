const NETWORK_TRANSFER_PATTERNS = Object.freeze([
  /(?:^|[;&|]\s*)(?:curl|wget)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i,
  /(?:^|[;&|]\s*)(?:scp|sftp|rsync)\b/i,
])

const SENSITIVE_SOURCE_PATTERNS = Object.freeze([
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /(?:^|[/\\])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b/i,
  /(?:^|[/\\])\.aws[/\\]credentials\b/i,
  /(?:^|[/\\])\.config[/\\]gcloud(?:[/\\]|$)/i,
  /(?:^|[/\\])\.npmrc\b/i,
  /(?:^|[/\\])\.netrc\b/i,
  /(?:^|[/\\])\.env(?:\.[A-Za-z0-9._-]+)?\b/i,
  /\$(?:\{)?(?:GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|PRIVATE_KEY)(?:\})?/i,
  /\$env:(?:GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|PRIVATE_KEY)\b/i,
])

const OUTBOUND_PAYLOAD_PATTERNS = Object.freeze([
  /(?:^|\s)(?:-d|--data|--data-binary|--data-raw|-F|--form|--upload-file|-T)(?:\s|=)/i,
  /\b(?:scp|sftp|rsync)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*(?:-Body|-InFile)\b/i,
  /(?:^|[^|])\|\s*(?:curl|wget)\b/i,
])

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value))
}

export function classifyExecutionCapabilities(command = "") {
  const text = String(command || "")
  const networkTransfer = matchesAny(NETWORK_TRANSFER_PATTERNS, text)
  const sensitiveSource = matchesAny(SENSITIVE_SOURCE_PATTERNS, text)
  const outboundPayload = matchesAny(OUTBOUND_PAYLOAD_PATTERNS, text)
  return {
    schemaVersion: 1,
    networkTransfer,
    sensitiveSource,
    outboundPayload,
    capabilities: [
      ...(networkTransfer ? ["network-transfer"] : []),
      ...(sensitiveSource ? ["sensitive-source"] : []),
      ...(outboundPayload ? ["outbound-payload"] : []),
    ],
  }
}

export function sensitiveExecutionRisk(command = "") {
  const classified = classifyExecutionCapabilities(command)
  const risky =
    classified.networkTransfer === true &&
    classified.sensitiveSource === true &&
    classified.outboundPayload === true
  return {
    ...classified,
    risky,
    id: risky ? "secret-network-exfiltration" : null,
    reason: risky
      ? "command combines credential/secret material with an outbound payload transfer"
      : null,
  }
}
