function Find-FeedRadarNode {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  $bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  throw 'Node.js 22.12 or later is required. Install the current LTS version from https://nodejs.org.'
}
