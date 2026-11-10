$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$target = Join-Path $appRoot '.env.docker'
if (Test-Path -LiteralPath $target) { Write-Host '.env.docker already exists; kept unchanged.'; exit 0 }
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[IO.File]::WriteAllText($target, "DOCKER_DB_PASSWORD=$password`n")
Write-Host 'Created ignored .env.docker. Run: docker compose --env-file .env.docker up --build -d'
