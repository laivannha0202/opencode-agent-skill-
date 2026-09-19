import { canEditProject } from "./auth.mjs"

export function updateProject(user, project, patch) {
  if (!canEditProject(user, project)) throw new Error("no")
  Object.assign(project, patch)
  return project
}
