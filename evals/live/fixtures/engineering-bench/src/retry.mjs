export function shouldRetry({ status, attempt, maxAttempts }) {
  return attempt <= maxAttempts
}
