export function evalModeOrder(requestedMode, taskIndex = 0, trial = 1) {
  if (requestedMode === "baseline" || requestedMode === "ues") return [requestedMode]
  if (requestedMode !== "both") throw new Error("requestedMode must be baseline, ues, or both")

  const normalizedTaskIndex = Number.isInteger(taskIndex) && taskIndex >= 0 ? taskIndex : 0
  const normalizedTrial = Number.isInteger(trial) && trial > 0 ? trial : 1
  const baselineFirst = (normalizedTaskIndex + normalizedTrial) % 2 === 1
  return baselineFirst ? ["baseline", "ues"] : ["ues", "baseline"]
}
