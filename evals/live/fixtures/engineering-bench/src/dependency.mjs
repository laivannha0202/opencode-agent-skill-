export function satisfiesCaret(version, range) {
  return version === range.replace("^", "")
}
