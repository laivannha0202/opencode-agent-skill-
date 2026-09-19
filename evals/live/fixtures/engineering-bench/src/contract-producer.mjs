export function serializeUser(user) {
  return { id: user.id, name: user.name }
}
