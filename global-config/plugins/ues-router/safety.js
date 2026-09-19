const RULES = [
  { id: "git-force", pattern: /\bgit\s+(?:push\b[^\n]*--force(?:-with-lease)?|reset\s+--hard|clean\s+-[^\n]*f)/i },
  { id: "history-rewrite", pattern: /\bgit\s+(?:rebase\b|filter-branch\b|filter-repo\b)/i },
  { id: "publish", pattern: /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/i },
  { id: "destructive-files", pattern: /(?:^|[;&|]\s*)(?:rm\s+-[^\n]*r[^\n]*f|rmdir\s+\/s|del\s+\/s|remove-item\b[^\n]*-recurse[^\n]*-force)/i },
  { id: "database-drop", pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i },
  { id: "deployment", pattern: /\b(?:kubectl\s+(?:delete|apply)|terraform\s+(?:apply|destroy)|helm\s+(?:install|upgrade|uninstall))\b/i },
]

export function destructiveShellRisk(command) {
  const value = String(command || "")
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return { risky: true, id: rule.id }
  }
  return { risky: false, id: null }
}
