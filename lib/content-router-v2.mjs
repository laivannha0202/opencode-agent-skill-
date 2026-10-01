function clean(value) {
  return String(value || "").trim().toLowerCase()
}

function looksJson(text) {
  const value = String(text || "").trim()
  if (!value || !/^[\[{]/.test(value)) return false
  try { JSON.parse(value); return true } catch { return false }
}

export function classifyContentType(text, options = {}) {
  const source = String(text || "")
  const hint = clean(options.command || options.source || options.kind)
  if (/\bgit\s+(?:diff|show)\b/.test(hint) || /^diff --git /m.test(source)) return "diff"
  if (looksJson(source) || /(?:--json|\bjson\b)/.test(hint)) return "json"
  if (/\b(?:jest|vitest|pytest|node --test|go test|cargo test|dotnet test|mvn test|gradle test)\b/.test(hint)) return "test"
  if (/\b(?:tsc|eslint|ruff|pylint|flake8|diagnostic|typecheck|lint)\b/.test(hint)) return "diagnostics"
  if (/\b(?:log|logs|journalctl|docker logs)\b/.test(hint) || /(?:^|\n).*(?:error|warn|fatal|info|debug).*(?:^|\n)/i.test(source.slice(0, 12000))) return "logs"
  if (/\b(?:cat|sed|read|source|code)\b/.test(hint) && /\b(?:class|function|const|let|def|import|export|interface|type)\b/.test(source.slice(0, 12000))) return "code"
  if (/\b(?:rg|ripgrep|grep|find|tree|ls)\b/.test(hint)) return "search"
  return "text"
}

export function routeToolContent(text, options = {}) {
  const contentType = classifyContentType(text, options)
  const phase = clean(options.phase || "execute")
  const command = clean(options.command)
  const table = {
    json: { reducer: "json", budgetMultiplier: 0.75, preserveSignal: true },
    logs: { reducer: "signal", budgetMultiplier: 0.70, preserveSignal: true },
    search: { reducer: "search", budgetMultiplier: 0.75, preserveSignal: true },
    test: { reducer: "verification-test", budgetMultiplier: 0.95, preserveSignal: true },
    diagnostics: { reducer: "diagnostics", budgetMultiplier: 1.10, preserveSignal: true },
    diff: { reducer: "git-diff", budgetMultiplier: phase === "verify" || phase === "review" ? 1.35 : 1.15, preserveSignal: true },
    code: { reducer: "code", budgetMultiplier: 1.25, preserveSignal: true },
    text: { reducer: "signal", budgetMultiplier: 1.0, preserveSignal: false },
  }
  const selected = table[contentType] || table.text
  return {
    schemaVersion: 2,
    contentType,
    phase: phase || "execute",
    reducer: selected.reducer,
    budgetMultiplier: selected.budgetMultiplier,
    preserveSignal: selected.preserveSignal,
    commandFamilyHint: command || null,
    cacheZone: "live",
  }
}
