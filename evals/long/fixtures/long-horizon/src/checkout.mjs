import { reserveAll } from "./inventory.mjs"
import { applyCharge } from "./payment.mjs"

export function checkout(order, stock, event) {
  return {
    order: applyCharge(order, event),
    stock: reserveAll(stock, order.lines || []),
  }
}
