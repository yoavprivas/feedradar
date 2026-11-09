param(
  [ValidateSet('start','stop','status')][string]$Action = 'start',
  [string]$PgBin = (Join-Path $PSScriptRoot '../../../.tools/postgresql/pgsql/bin')
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $appRoot '.local/postgres'
$localDir = Join-Path $appRoot '.local'
$envFile = Join-Path $appRoot '.env'
$pgCtl = Join-Path $PgBin 'pg_ctl.exe'
if (!(Test-Path -LiteralPath $pgCtl)) { throw 'PostgreSQL binaries not found. Pass -PgBin with the bin directory of PostgreSQL 17 or later.' }
if ($Action -eq 'stop') { & $pgCtl -D $dataDir -m fast -w stop; exit $LASTEXITCODE }
if ($Action -eq 'status') { & $pgCtl -D $dataDir status; exit $LASTEXITCODE }
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$fresh = !(Test-Path -LiteralPath (Join-Path $dataDir 'PG_VERSION'))
if ($fresh) {
  if (Test-Path -LiteralPath $envFile) { throw '.env already exists; use your configured PostgreSQL or move it aside deliberately before initializing a new local database.' }
  $adminPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  $appPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  $passwordFile = Join-Path $localDir 'init-password'
  [IO.File]::WriteAllText($passwordFile, $adminPassword)
  try {
    & (Join-Path $PgBin 'initdb.exe') -D $dataDir -U feedradar_admin -A scram-sha-256 --pwfile=$passwordFile --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  } finally { Remove-Item -LiteralPath $passwordFile -Force }
  Add-Content -LiteralPath (Join-Path $dataDir 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = 55432`n"
}
& $pgCtl -D $dataDir status *> $null
if ($LASTEXITCODE -ne 0) {
  $logFile = Join-Path $localDir 'postgres.log'
  & $pgCtl -D $dataDir -l $logFile -w start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start; inspect .local/postgres.log' }
}
if ($fresh) {
  $previousPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $adminPassword
    $sql = "CREATE ROLE feedradar LOGIN PASSWORD '$appPassword';`nCREATE DATABASE feedradar OWNER feedradar;`nCREATE DATABASE feedradar_test OWNER feedradar;"
    $sql | & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p 55432 -U feedradar_admin -d postgres -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Database provisioning failed' }
    [IO.File]::WriteAllText($envFile, "DATABASE_URL=postgresql://feedradar:$appPassword@127.0.0.1:55432/feedradar`nTEST_DATABASE_URL=postgresql://feedradar:$appPassword@127.0.0.1:55432/feedradar_test`nPORT=4310`nSCAN_INTERVAL_MINUTES=30`nREQUEST_TIMEOUT_MS=12000`nMIN_REFRESH_SECONDS=60`n")
    # Only used to recover this isolated cluster, never tracked or printed.
    [IO.File]::WriteAllText((Join-Path $localDir 'admin-password'), $adminPassword)
  } finally { $env:PGPASSWORD = $previousPassword }
}
Write-Host 'Local PostgreSQL is ready on 127.0.0.1:55432. Credentials are stored only in ignored local files.'
