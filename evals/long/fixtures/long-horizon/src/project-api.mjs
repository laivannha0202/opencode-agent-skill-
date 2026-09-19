import { updateProject } from "./project-service.mjs"

export function handleProjectUpdate(input) {
  try {
    return { status: 200, body: { project: updateProject(input.user, input.project, input.patch) } }
  } catch (error) {
    return { status: 500, body: { error } }
  }
}
