function parse(value) {
  const match = String(value).trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  if (!match) throw new Error(`Invalid semantic version: ${value}`)

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null

  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareVersions(left, right) {
  const a = parse(left)
  const b = parse(right)

  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return Math.sign(a.core[index] - b.core[index])
    }
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1

    const compared = compareIdentifier(a.prerelease[index], b.prerelease[index])
    if (compared !== 0) return compared
  }

  return 0
}
