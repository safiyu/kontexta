#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

Set-Location $PSScriptRoot

Step 'Checking working tree is clean'
if (git status --porcelain) {
  Fail 'Uncommitted changes found. Commit or stash them first: git stash'
}

Step 'Checking current branch tracks a remote'
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' *> $null
if ($LASTEXITCODE -ne 0) {
  Fail 'Current branch has no upstream to pull from.'
}

Step 'Pulling latest changes (fast-forward only)'
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
  Fail 'Fast-forward pull failed — you have local commits ahead of upstream. Rebase or merge manually, then re-run .\update.ps1.'
}

Step 'Re-running bootstrap (picks up any Node/pnpm version change)'
& (Join-Path $PSScriptRoot 'bootstrap.ps1')
if ($LASTEXITCODE -ne 0) { Fail 'bootstrap failed' }

Step 'Building the full workspace (core, mcp, web)'
pnpm build
if ($LASTEXITCODE -ne 0) { Fail 'build failed' }

Write-Host ''
Write-Host '✓ Update complete.' -ForegroundColor Green
Write-Host '  Restart pnpm dev (or your production process) to pick up the new build.'
