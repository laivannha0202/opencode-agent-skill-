import path from "node:path"

export function safeJoin(root, userPath) {
  return path.join(root, userPath)
}
