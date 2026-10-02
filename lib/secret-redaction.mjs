// V16.3 shared secret redaction.
//
// Both halves of V16.3 produce outbound text that must never carry credentials:
// browser action receipts (Phase A) and the DeepSeek Decision Packet (Phase B).
// The rule that matters is the fail-closed one: when a detector fires, the whole
// value is replaced rather than partially scrubbed, because a half-scrubbed
// secret is still a leaked secret. This module therefore exports a detector
// table plus one redactor, and both phases import the same one so the two
// subsystems cannot drift apart on what counts as a secret.

const SECRET_KEY_PATTERN =
  /(?:^|[^a-z0-9])(?:x-goog-api-key|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer|authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key|session[_-]?id|csrf|credit[_-]?card|card[_-]?number|cvv|pin|otp|webhook[_-]?secret|signing[_-]?key|smtp[_-]?pass)(?:[^a-z0-9]|$)/i

const SECRET_ENV_KEY_PATTERN =
  /^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|AUTH)[A-Z0-9_]*$/

const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const BASIC_VALUE = /\bbasic\s+[A-Za-z0-9+/=]{8,}/gi
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g
const AWS_KEY = /\bAKIA[0-9A-Z]{12,}\b/g
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
const SLACK_TOKEN = /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{20,}\b/g
const STRIPE_KEY = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g
const PEM_PRIVATE_KEY = /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]{0,4000}?-----END[ A-Z]*PRIVATE KEY-----/g
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]{0,200}?-----END [A-Z ]+-----/g
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi
const CREDENTIALS_IN_URL = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/:@]+):([^\s/@]+)@/gi

export const REDACTION_MASK = "[REDACTED]"

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Environment values are the single most common accidental leak, so callers can
// register the live values from the current environment and have them masked
// even when they never appear next to a recognizable key name.
export function envSecretValues(env = process.env, options = {}) {
  const max = Math.max(1, Math.min(200, Number(options.max || 40)))
  const source = env && typeof env === "object" ? env : {}
  const explicitKeys = new Set(
    [...(options.keys || []), ...Object.keys(source)].filter(
      (key) => SECRET_ENV_KEY_PATTERN.test(String(key).toUpperCase()),
    ),
  )
  const values = []
  for (const key of explicitKeys) {
    const value = String(source[key] ?? "")
    if (value.length < 8 || value.length > 4096) continue
    values.push(value)
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length).slice(0, max)
}

export function secretValueDetectors(envValues = [], options = {}) {
  const minLength = Math.max(4, Math.min(512, Number(options.minLength || 8)))
  const detectors = [
    { id: "pem-private-key", pattern: PEM_PRIVATE_KEY },
    { id: "bearer-token", pattern: BEARER_VALUE },
    { id: "basic-auth", pattern: BASIC_VALUE },
    { id: "jwt", pattern: JWT_VALUE },
    { id: "aws-access-key", pattern: AWS_KEY },
    { id: "provider-api-key", pattern: OPENAI_STYLE_KEY },
    { id: "github-token", pattern: GITHUB_TOKEN },
    { id: "slack-token", pattern: SLACK_TOKEN },
    { id: "google-api-key", pattern: GOOGLE_KEY },
    { id: "stripe-key", pattern: STRIPE_KEY },
    { id: "credentialed-url", pattern: CONNECTION_STRING },
    { id: "basic-auth-url", pattern: CREDENTIALS_IN_URL },
  ]
  for (const value of envValues || []) {
    if (typeof value !== "string" || value.length < minLength) continue
    detectors.push({ id: "env-value", pattern: new RegExp(escapeRegExp(value), "g") })
  }
  return detectors
}

// A key/value pair is treated as secret when the KEY looks like a credential
// name AND the value is non-empty. That is deliberately conservative about
// keys and deliberately aggressive about replacing: `password: "hunter2"` must
// be masked even though `hunter2` matches no token shape.
export function redactKeyValuePairs(text, options = {}) {
  const mask = String(options.mask || REDACTION_MASK)
  const maxKeys = Math.max(1, Math.min(500, Number(options.maxKeys || 200)))
  const line = /(["'`]?)([A-Za-z0-9_.$-]{1,64})\1\s*[:=]\s*(["'`]?)([^"'`\r\n]{0,4096})\3/g
  let masked = String(text || "")
  let hits = 0
  masked = masked.replace(line, (match, q1, key, q2, value) => {
    if (hits >= maxKeys) return match
    if (!SECRET_KEY_PATTERN.test(String(key || ""))) return match
    if (!String(value || "").trim()) return match
    hits += 1
    return `${q1}${key}${q1}: ${q2}${mask}${q2}`
  })
  return { text: masked, hits }
}

export function redactSecrets(value, options = {}) {
  const mask = String(options.mask || REDACTION_MASK)
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  const envValues = options.envValues || envSecretValues(options.env || process.env, options)
  const detectors = secretValueDetectors(envValues, options)

  let masked = text
  let hits = 0
  for (const detector of detectors) {
    detector.pattern.lastIndex = 0
    masked = masked.replace(detector.pattern, () => {
      hits += 1
      return mask
    })
  }
  masked = masked.replace(PEM_BLOCK, () => {
    hits += 1
    return mask
  })

  const pairs = redactKeyValuePairs(masked, { mask })
  masked = pairs.text
  hits += pairs.hits

  return {
    text: masked,
    redacted: hits > 0,
    hits,
    detectors: detectors.length,
    trustLevel: "untrusted-external",
  }
}

// Recursive redaction for structured evidence objects (receipts, packets).
// Depth and breadth are bounded so a hostile payload cannot turn redaction into
// a denial of service.
export function redactStructure(value, options = {}) {
  const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth || 6)))
  const maxKeys = Math.max(1, Math.min(5000, Number(options.maxKeys || 1000)))
  const mask = String(options.mask || REDACTION_MASK)
  const envValues = options.envValues || envSecretValues(options.env || process.env, options)
  const detectors = secretValueDetectors(envValues, options)
  let hits = 0
  let keys = 0
  let truncated = false

  const scrubString = (raw) => {
    let masked = raw
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0
      masked = masked.replace(detector.pattern, () => {
        hits += 1
        return mask
      })
    }
    const pairs = redactKeyValuePairs(masked, { mask })
    if (pairs.hits) {
      hits += pairs.hits
      masked = pairs.text
    }
    return masked
  }

  const walk = (node, depth) => {
    if (node === null || node === undefined) return node ?? null
    if (typeof node === "string") return scrubString(node)
    if (typeof node === "number" || typeof node === "boolean") return node
    if (depth >= maxDepth) {
      truncated = true
      return mask
    }
    if (Array.isArray(node)) {
      const out = []
      for (const item of node.slice(0, maxKeys)) {
        keys += 1
        out.push(walk(item, depth + 1))
      }
      if (node.length > maxKeys) truncated = true
      return out
    }
    if (typeof node !== "object") return mask
    const out = {}
    for (const [key, item] of Object.entries(node)) {
      keys += 1
      if (keys > maxKeys) {
        truncated = true
        break
      }
      const secretKey = SECRET_KEY_PATTERN.test(String(key))
      const nonEmpty = !(typeof item === "string" && !item.trim())
      if (secretKey && nonEmpty) {
        hits += 1
        out[key] = mask
        continue
      }
      out[key] = walk(item, depth + 1)
    }
    return out
  }

  return { value: walk(value, 0), redacted: hits > 0, hits, keys, truncated }
}

export function containsSecret(value, options = {}) {
  const envValues = options.envValues || envSecretValues(options.env || process.env, options)
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  for (const detector of secretValueDetectors(envValues, options)) {
    detector.pattern.lastIndex = 0
    if (detector.pattern.test(text)) return true
  }
  return redactKeyValuePairs(text).hits > 0
}