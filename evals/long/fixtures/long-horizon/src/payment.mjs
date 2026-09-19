export function applyCharge(order, event) {
  return {
    ...order,
    status: event.status === "succeeded" ? "paid" : order.status,
    processedEvents: [...(order.processedEvents || []), event.id],
  }
}
