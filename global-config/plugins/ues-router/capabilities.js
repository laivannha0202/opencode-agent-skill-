export function runtimeCapabilities(ctx) {
  const session = ctx?.session || {}
  const capabilities = {
    sessionCreate: typeof session.create === "function",
    sessionPrompt: typeof session.prompt === "function",
    sessionWait: typeof session.wait === "function",
    sessionContext: typeof session.context === "function",
    sessionSwitchAgent: typeof session.switchAgent === "function",
    sessionSwitchModel: typeof session.switchModel === "function",
    sessionHook: typeof session.hook === "function",
  }
  capabilities.freshDispatch =
    capabilities.sessionCreate &&
    capabilities.sessionPrompt &&
    capabilities.sessionWait &&
    capabilities.sessionContext &&
    capabilities.sessionSwitchAgent
  capabilities.modelSwitch = capabilities.sessionSwitchModel
  return capabilities
}
