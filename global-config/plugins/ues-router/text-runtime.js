import { readFileSync } from "node:fs"
import path from "node:path"

function swapUtf16(buffer) {
  const evenLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1]
    swapped[index + 1] = buffer[index]
  }
  return swapped.toString("utf16le")
}

function utf16Guess(buffer) {
  if (buffer.length < 4) return null
  let evenNull = 0
  let oddNull = 0
  let even = 0
  let odd = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (index % 2 === 0) {
      even += 1
      if (buffer[index] === 0) evenNull += 1
    } else {
      odd += 1
      if (buffer[index] === 0) oddNull += 1
    }
  }
  const er = even ? evenNull / even : 0
  const or = odd ? oddNull / odd : 0
  if (or >= 0.25 && er <= 0.05) return "utf16le"
  if (er >= 0.25 && or <= 0.05) return "utf16be"
  return null
}

function decode(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf8-bom" }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf16le" }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: swapUtf16(buffer.subarray(2)), encoding: "utf16be" }
  }
  const guess = utf16Guess(buffer)
  if (guess === "utf16le") return { text: buffer.toString("utf16le"), encoding: guess }
  if (guess === "utf16be") return { text: swapUtf16(buffer), encoding: guess }

  let nul = 0
  for (const byte of buffer) if (byte === 0) nul += 1
  if (nul > Math.max(2, Math.floor(buffer.length * 0.01))) {
    const error = new Error("file appears to be binary rather than UTF text")
    error.code = "UES_BINARY_TEXT"
    throw error
  }
  return { text: buffer.toString("utf8"), encoding: "utf8" }
}

export function readProjectText(root, relative, options = {}) {
  root = path.resolve(root)
  const file = path.resolve(root, String(relative || ""))
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error("text_read path must stay inside the project root")
  }
  const buffer = readFileSync(file)
  const decoded = decode(buffer)
  const start = Math.max(0, Number(options.start || 0))
  const maxChars = Math.max(256, Math.min(Number(options.maxChars || 12000), 100000))
  const text = decoded.text.slice(start, start + maxChars)
  return {
    schemaVersion: 1,
    file: path.relative(root, file).replaceAll("\\", "/") || ".",
    encoding: decoded.encoding,
    bytes: buffer.length,
    chars: decoded.text.length,
    start,
    returnedChars: text.length,
    truncated: start + text.length < decoded.text.length,
    text,
  }
}
