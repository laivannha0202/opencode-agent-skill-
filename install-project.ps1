param([Parameter(Mandatory=$true)][string]$ProjectPath)
$ErrorActionPreference="Stop"
$source=Join-Path $PSScriptRoot "global-config"; $project=(Resolve-Path $ProjectPath).Path; $oc=Join-Path $project ".opencode"
foreach($dir in @("skills","agents","commands")){ New-Item -ItemType Directory -Force -Path (Join-Path $oc $dir)|Out-Null; Copy-Item -Recurse -Force (Join-Path $source "$dir\*") (Join-Path $oc $dir) }
$af=Join-Path $project "AGENTS.md"; if(-not(Test-Path $af)){Copy-Item -Force (Join-Path $source "AGENTS.md") $af}else{Write-Host "Project AGENTS.md exists; left unchanged."}
Write-Host "Installed project-local system into $project"
