param([switch]$InstallRecommendedConfig)
$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "global-config"
$target = Join-Path $env:USERPROFILE ".config\opencode"
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($dir in @("skills","agents","commands")) { New-Item -ItemType Directory -Force -Path (Join-Path $target $dir) | Out-Null; Copy-Item -Recurse -Force (Join-Path $source "$dir\*") (Join-Path $target $dir) }
$ga = Join-Path $target "AGENTS.md"
if (Test-Path $ga) { $stamp=Get-Date -Format "yyyyMMdd-HHmmss"; Copy-Item $ga "$ga.backup-$stamp"; Write-Host "Backed up existing AGENTS.md" }
Copy-Item -Force (Join-Path $source "AGENTS.md") $ga
if ($InstallRecommendedConfig) {
  $j=Join-Path $target "opencode.json"; $jc=Join-Path $target "opencode.jsonc"
  if ((Test-Path $j) -or (Test-Path $jc)) { Write-Warning "Existing OpenCode config found; not overwritten. Merge opencode.recommended.jsonc manually." }
  else { Copy-Item -Force (Join-Path $PSScriptRoot "opencode.recommended.jsonc") $jc; Write-Host "Installed recommended opencode.jsonc" }
}
Write-Host "Installed Universal Engineering System V2 globally. Restart OpenCode or start a new session. Keep using Build normally."
