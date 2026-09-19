export function serializeUser(user) {
  return { id: user.id, displayName: user.displayName || user.name }
}
