export function advancePaymentState(state, event) {
  return { status: event.status, lastSequence: event.sequence }
}
