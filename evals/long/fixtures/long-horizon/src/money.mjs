export function calculateTotal(lines) {
  return lines.reduce((sum, line) => sum + line.unitPriceCents, 0)
}
