const VALID_DECISIONS = new Set(["allow", "deny", "modify", "observe"])

function normalizedEvent(value) {
  return String(value || "").trim().toLowerCase()
}

export class RuntimeHookBus {
  constructor() {
    this.hooks = new Map()
  }

  on(event, fn, options = {}) {
    if (typeof fn !== "function") throw new TypeError("RuntimeHookBus.on requires a function")
    const name = normalizedEvent(event)
    if (!name) throw new Error("RuntimeHookBus.on requires an event")
    const rows = this.hooks.get(name) || []
    const row = {
      fn,
      name: String(options.name || fn.name || "anonymous-hook"),
      priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 0,
      critical: options.critical === true,
    }
    rows.push(row)
    rows.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    this.hooks.set(name, rows)
    return () => {
      const current = this.hooks.get(name) || []
      this.hooks.set(name, current.filter((item) => item !== row))
    }
  }

  async emit(event, payload = {}, context = {}) {
    const name = normalizedEvent(event)
    const rows = this.hooks.get(name) || []
    let current = payload
    const results = []
    const errors = []

    for (const row of rows) {
      try {
        const value = await row.fn(current, context)
        if (!value) {
          results.push({ hook: row.name, decision: "observe" })
          continue
        }
        const decision = VALID_DECISIONS.has(String(value.decision))
          ? String(value.decision)
          : "observe"
        results.push({ hook: row.name, decision, reason: value.reason || null })
        if (decision === "deny") {
          return {
            schemaVersion: 1,
            event: name,
            decision: "deny",
            reason: String(value.reason || ("denied by " + row.name)),
            payload: current,
            results,
            errors,
          }
        }
        if (decision === "modify" && value.patch && typeof value.patch === "object") {
          current = { ...current, ...value.patch }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push({ hook: row.name, message })
        if (row.critical) {
          return {
            schemaVersion: 1,
            event: name,
            decision: "deny",
            reason: "critical hook failed: " + row.name + ": " + message,
            payload: current,
            results,
            errors,
          }
        }
      }
    }

    return {
      schemaVersion: 1,
      event: name,
      decision: current === payload ? "allow" : "modify",
      payload: current,
      results,
      errors,
    }
  }

  snapshot() {
    return {
      schemaVersion: 1,
      events: Object.fromEntries(
        [...this.hooks.entries()].map(([event, rows]) => [
          event,
          rows.map((row) => ({ name: row.name, priority: row.priority, critical: row.critical })),
        ]),
      ),
    }
  }
}
