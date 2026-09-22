import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

function swappedUtf16(buffer) {
  const evenLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1]
    swapped[index + 1] = buffer[index]
  }
  return swapped.toString("utf16le")
}

function utf16Heuristic(buffer) {
  if (buffer.length < 4) return null
  let evenNulls = 0
  let oddNulls = 0
  let evenCount = 0
  let oddCount = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (index % 2 === 0) {
      evenCount += 1
      if (buffer[index] === 0) evenNulls += 1
    } else {
      oddCount += 1
      if (buffer[index] === 0) oddNulls += 1
    }
  }
  const evenRatio = evenCount ? evenNulls / evenCount : 0
  const oddRatio = oddCount ? oddNulls / oddCount : 0
  if (oddRatio >= 0.25 && evenRatio <= 0.05) return "utf16le"
  if (evenRatio >= 0.25 && oddRatio <= 0.05) return "utf16be"
  return null
}

export function decodeTextBuffer(value, options = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "")
  if (buffer.length === 0) return ""

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8")
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le")
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swappedUtf16(buffer.subarray(2))
  }

  const guessed = utf16Heuristic(buffer)
  if (guessed === "utf16le") return buffer.toString("utf16le")
  if (guessed === "utf16be") return swappedUtf16(buffer)

  let nulBytes = 0
  for (const byte of buffer) if (byte === 0) nulBytes += 1
  if (nulBytes > Math.max(2, Math.floor(buffer.length * 0.01)) && options.allowBinary !== true) {
    const error = new Error("file appears to be binary; refusing lossy text decoding")
    error.code = "UES_BINARY_TEXT"
    error.exitCode = 2
    throw error
  }

  return buffer.toString("utf8")
}

export function readTextAuto(file, options = {}) {
  return decodeTextBuffer(readFileSync(path.resolve(file)), options)
}

export function writeUtf8Text(file, text) {
  const resolved = path.resolve(file)
  writeFileSync(resolved, String(text ?? ""), "utf8")
  return resolved
}
