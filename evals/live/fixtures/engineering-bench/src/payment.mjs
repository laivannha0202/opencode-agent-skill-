export function applyPaymentEvent(order, event) {
  order.status = "paid"
  order.processedEvents.push(event.id)
  return order
}
