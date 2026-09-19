export function validateSerializedUser(user) {
  return Boolean(user && user.id && user.displayName)
}
