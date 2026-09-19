export function reserveAll(stock, lines) {
  const next = stock
  for (const line of lines) next[line.sku] = (next[line.sku] || 0) - line.quantity
  return next
}
