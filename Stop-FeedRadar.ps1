param([switch]$StopDatabase)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot '.local/server.pid'
if (Test-Path -LiteralPath $pidFile) {
  $ownedId = [int](Get-Content -LiteralPath $pidFile -Raw)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction SilentlyContinue
  if ($processInfo -and $processInfo.CommandLine -match 'tsx[\\/]dist[\\/]cli.mjs.*backend[\\/]index.ts') {
    # tsx launches a child Node process; stop only this verified process tree.
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownedId"
    foreach ($child in $children) { if ($child.Name -eq 'node.exe') { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue } }
    Stop-Process -Id $ownedId -ErrorAction SilentlyContinue
  } elseif ($processInfo) { throw 'PID belongs to a different process. Refusing to stop it.' }
  Remove-Item -LiteralPath $pidFile -Force
}
if ($StopDatabase) { & (Join-Path $PSScriptRoot 'scripts/local-db.ps1') stop }
Write-Host 'FeedRadar stopped.'
