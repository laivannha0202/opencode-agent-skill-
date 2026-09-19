export function toHttpError(error) {
  return { status: 500, body: { error: error.message } }
}
