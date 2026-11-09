param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/runtime.ps1')
$nodePath = Find-FeedRadarNode
Set-Location -LiteralPath $PSScriptRoot
if (!(Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example and configure PostgreSQL. See README.md.' }
if (!(Test-Path -LiteralPath 'node_modules/tsx/dist/cli.mjs')) { throw 'Install dependencies first: npm install. See README.md.' }
if (Test-Path -LiteralPath '.local/postgres/PG_VERSION') { & (Join-Path $PSScriptRoot 'scripts/local-db.ps1') start }
$port = 4310
foreach ($line in Get-Content -LiteralPath '.env') { if ($line -match '^PORT=(\d+)$') { $port = [int]$Matches[1] } }
$url = "http://127.0.0.1:$port"
$alreadyRunning = $false
try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2; $alreadyRunning = $health.status -eq 'ok' -and $health.database -eq 'postgresql' } catch {}
if ($alreadyRunning) { Write-Host "FeedRadar already running: $url"; if (!$NoBrowser) { Start-Process $url }; exit 0 }
if (!(Test-Path -LiteralPath 'dist/index.html')) {
  & $nodePath node_modules/typescript/bin/tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw 'Type checking failed' }
  & $nodePath node_modules/vite/bin/vite.js build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
$process = Start-Process -FilePath $nodePath -ArgumentList @('node_modules/tsx/dist/cli.mjs','server/index.ts') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput '.local/server.log' -RedirectStandardError '.local/server-error.log' -PassThru
$process.Id | Set-Content -LiteralPath '.local/server.pid'
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1; if ($health.status -eq 'ok') { Write-Host "FeedRadar ready: $url"; if (!$NoBrowser) { Start-Process $url }; exit 0 } } catch {}
  if ($process.HasExited) { throw 'Server exited. See .local/server-error.log.' }
  Start-Sleep -Milliseconds 300
}
throw 'Server did not become ready. See .local/server-error.log.'
