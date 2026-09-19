export function migrateUser(user) {
  const [firstName = "", ...rest] = String(user.fullName || "").trim().split(/\s+/)
  user.firstName = firstName
  user.lastName = rest.join(" ")
  delete user.fullName
  return user
}
