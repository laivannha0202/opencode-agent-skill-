import { inflateSync, deflateSync } from "node:zlib"
import { readFile, writeFile } from "node:fs/promises"

const SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function bytesPerPixel(colorType) {
  if (colorType === 0 || colorType === 3) return 1
  if (colorType === 2) return 3
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  throw new Error("Unsupported PNG color type: " + colorType)
}

function parseChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Invalid PNG signature")
  const chunks = []
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error("Truncated PNG chunk")
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4
    if (type === "IEND") break
  }
  return chunks
}

export function decodePng(buffer) {
  const chunks = parseChunks(buffer)
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data
  if (!ihdr || ihdr.length < 13) throw new Error("PNG missing IHDR")
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8) throw new Error("Only 8-bit PNG is supported")
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported")

  const paletteChunk = chunks.find((chunk) => chunk.type === "PLTE")?.data || null
  const transparency = chunks.find((chunk) => chunk.type === "tRNS")?.data || null
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data))
  const bpp = bytesPerPixel(colorType)
  const pixelsCount = width * height
  if (!Number.isSafeInteger(pixelsCount) || pixelsCount <= 0 || pixelsCount > 50_000_000) {
    throw new Error("PNG dimensions exceed the V11 visual safety budget")
  }
  const stride = width * bpp
  const expectedRawBytes = height * (1 + stride)
  if (!Number.isSafeInteger(expectedRawBytes) || expectedRawBytes > 256 * 1024 * 1024) {
    throw new Error("PNG decompressed payload exceeds the V11 visual safety budget")
  }
  const raw = inflateSync(idat, { maxOutputLength: expectedRawBytes })
  if (raw.length !== expectedRawBytes) throw new Error("PNG decompressed payload length does not match IHDR")
  const pixels = Buffer.alloc(stride * height)
  let input = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[input++]
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[input++]
      const left = x >= bpp ? pixels[row + x - bpp] : 0
      const up = y > 0 ? pixels[row - stride + x] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[row - stride + x - bpp] : 0
      let value
      if (filter === 0) value = byte
      else if (filter === 1) value = (byte + left) & 255
      else if (filter === 2) value = (byte + up) & 255
      else if (filter === 3) value = (byte + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) value = (byte + paeth(left, up, upLeft)) & 255
      else throw new Error("Unsupported PNG filter: " + filter)
      pixels[row + x] = value
    }
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, p = 0; i < pixels.length; i += bpp, p += 4) {
    if (colorType === 6) {
      rgba[p] = pixels[i]; rgba[p+1] = pixels[i+1]; rgba[p+2] = pixels[i+2]; rgba[p+3] = pixels[i+3]
    } else if (colorType === 2) {
      rgba[p] = pixels[i]; rgba[p+1] = pixels[i+1]; rgba[p+2] = pixels[i+2]; rgba[p+3] = 255
    } else if (colorType === 0) {
      rgba[p] = pixels[i]; rgba[p+1] = pixels[i]; rgba[p+2] = pixels[i]; rgba[p+3] = 255
    } else if (colorType === 4) {
      rgba[p] = pixels[i]; rgba[p+1] = pixels[i]; rgba[p+2] = pixels[i]; rgba[p+3] = pixels[i+1]
    } else if (colorType === 3) {
      if (!paletteChunk) throw new Error("Indexed PNG missing PLTE")
      const index = pixels[i]
      rgba[p] = paletteChunk[index * 3] ?? 0
      rgba[p+1] = paletteChunk[index * 3 + 1] ?? 0
      rgba[p+2] = paletteChunk[index * 3 + 2] ?? 0
      rgba[p+3] = transparency?.[index] ?? 255
    }
  }
  return { width, height, rgba }
}

let crcTable = null
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

export function encodeRgbaPng({ width, height, rgba }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("Invalid PNG dimensions")
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) throw new Error("Invalid RGBA buffer")
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scan = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4)
    scan[row] = 0
    rgba.copy(scan, row + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))])
}

export function comparePngBuffers(expectedBuffer, actualBuffer, options = {}) {
  const expected = decodePng(expectedBuffer)
  const actual = decodePng(actualBuffer)
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      schemaVersion: 1,
      verdict: "FAIL",
      reason: "dimension-mismatch",
      expected: { width: expected.width, height: expected.height },
      actual: { width: actual.width, height: actual.height },
      differentPixels: expected.width * expected.height,
      differentRatio: 1,
      bounds: { x: 0, y: 0, width: Math.max(expected.width, actual.width), height: Math.max(expected.height, actual.height) },
    }
  }

  const threshold = Math.max(0, Math.min(255, Number(options.threshold ?? 16)))
  const allowedRatio = Math.max(0, Math.min(1, Number(options.maxDiffRatio ?? 0)))
  let differentPixels = 0
  let minX = expected.width
  let minY = expected.height
  let maxX = -1
  let maxY = -1

  for (let pixel = 0; pixel < expected.width * expected.height; pixel += 1) {
    const offset = pixel * 4
    let delta = 0
    for (let channel = 0; channel < 4; channel += 1) {
      delta = Math.max(delta, Math.abs(expected.rgba[offset + channel] - actual.rgba[offset + channel]))
    }
    if (delta <= threshold) continue
    differentPixels += 1
    const x = pixel % expected.width
    const y = Math.floor(pixel / expected.width)
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }

  const totalPixels = expected.width * expected.height
  const differentRatio = totalPixels ? differentPixels / totalPixels : 0
  const bounds = differentPixels
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null

  return {
    schemaVersion: 1,
    verdict: differentRatio <= allowedRatio ? "PASS" : "FAIL",
    width: expected.width,
    height: expected.height,
    differentPixels,
    differentRatio,
    threshold,
    maxDiffRatio: allowedRatio,
    bounds,
  }
}

export async function comparePngFiles(expectedFile, actualFile, options = {}) {
  return comparePngBuffers(await readFile(expectedFile), await readFile(actualFile), options)
}

export function cropDecodedPng(decoded, bounds) {
  const x = Math.max(0, Math.floor(Number(bounds?.x || 0)))
  const y = Math.max(0, Math.floor(Number(bounds?.y || 0)))
  const width = Math.max(1, Math.min(decoded.width - x, Math.floor(Number(bounds?.width || decoded.width))))
  const height = Math.max(1, Math.min(decoded.height - y, Math.floor(Number(bounds?.height || decoded.height))))
  const rgba = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * decoded.width + x) * 4
    decoded.rgba.copy(rgba, row * width * 4, sourceStart, sourceStart + width * 4)
  }
  return { width, height, rgba }
}

export async function cropPngFile(inputFile, outputFile, bounds) {
  const decoded = decodePng(await readFile(inputFile))
  const cropped = cropDecodedPng(decoded, bounds)
  await writeFile(outputFile, encodeRgbaPng(cropped))
  return { file: outputFile, width: cropped.width, height: cropped.height }
}
