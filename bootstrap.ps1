#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

Step 'Checking Node version'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node is not installed. Install Node 22.x LTS (see .nvmrc) via nvm-windows/fnm/volta.'
}
$requiredMajor = (Get-Content .nvmrc).Trim().TrimStart('v').Split('.')[0]
$currentMajor  = (node -p 'process.versions.node.split(".")[0]').Trim()
if ($currentMajor -ne $requiredMajor) {
  Fail "Node v$currentMajor detected; kontexta requires v$requiredMajor.x. Run 'nvm use' / 'fnm use' / 'volta pin node@$requiredMajor'."
}

Step 'Enabling corepack + pinned pnpm'
$pnpmVersion = (node -p "require('./package.json').packageManager.split('@')[1]").Trim()
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  Fail 'corepack is missing. Reinstall Node or run: npm install -g corepack'
}
corepack enable | Out-Null
corepack prepare "pnpm@$pnpmVersion" --activate | Out-Null

Step 'Probing C/C++ toolchain (needed for native-module fallback builds)'
# vswhere ships with every VS 2017+ install (any edition: BuildTools,
# Community, Professional, Enterprise) and lives at a fixed path.
$hasVc = $false
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($vsPath) { $hasVc = $true }
}
if (-not $hasVc -and (Get-Command cl -ErrorAction SilentlyContinue)) { $hasVc = $true }
if (-not $hasVc) {
  Fail 'No Visual Studio C++ toolchain found. Install "Build Tools for Visual Studio" with the "Desktop development with C++" workload: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022'
}

Step 'Installing workspace dependencies (pnpm install --frozen-lockfile)'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed' }

Step 'Building kxta-core'
pnpm -C packages/core build
if ($LASTEXITCODE -ne 0) { Fail 'core build failed' }

Step 'Flagging manual install (lets the dashboard show a real MCP config)'
Join-Path $PSScriptRoot 'apps\mcp\dist\index.js' | Set-Content -Path (Join-Path $PSScriptRoot '.kontexta-manual-mcp') -NoNewline

Write-Host ''
Write-Host '✓ Bootstrap complete.' -ForegroundColor Green
Write-Host '  Next: pnpm dev       Turbopack dev server on :23002'
Write-Host '        pnpm dev:lite  webpack, low-memory alternative'
Write-Host '        pnpm test       run vitest across the workspace'
