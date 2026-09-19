import { serializeUser } from "./contract-producer.mjs"

export function userLabel(user) {
  const dto = serializeUser(user)
  return dto.displayName
}
