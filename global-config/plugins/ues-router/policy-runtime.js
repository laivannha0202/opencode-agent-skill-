// Legacy OpenCode router compatibility shim.
// The canonical task policy is Pi-native and lives in lib/task-policy.mjs.
// Keep this file only so older installations do not fork policy behavior.
export {
  classifyEngineeringTask,
  recoveryPolicyForAttempt,
} from "../../../lib/task-policy.mjs"
