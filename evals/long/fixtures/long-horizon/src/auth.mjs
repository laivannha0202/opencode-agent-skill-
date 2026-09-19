export function canEditProject(user, project) {
  if (!user || !project) return false
  if (user.role === "admin") return true
  return user.id === project.ownerId
}
