param(
  [string]$EnvFile = "",
  [string]$PlatformAccessToken = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "../..")
if (-not $EnvFile) { $EnvFile = Join-Path $Root "config/.env" }
if (-not $PlatformAccessToken) { $PlatformAccessToken = $env:PLATFORM_ACCESS_TOKEN }

Push-Location $Root
try {
  npm ci

  if ($PlatformAccessToken) {
    node scripts/desktop-pairing.mjs --start --access-token $PlatformAccessToken --env-file $EnvFile
  } else {
    node scripts/desktop-pairing.mjs --start --env-file $EnvFile
  }
  node scripts/desktop-pairing.mjs --wait --env-file $EnvFile

  $serviceDir = Join-Path $Root "deploy/agent/windows"
  New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

  $runnerCmd = "cd /d $Root && set CONFIG_ENV_FILE=$EnvFile && node runner/runner.js"
  $connectorCmd = "cd /d $Root && set CONFIG_ENV_FILE=$EnvFile && node runner/chat_connector.js"

  if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "nssm not found. Please install NSSM and rerun to register Windows services."
    exit 1
  }

  nssm install CodexRelayRunner "cmd.exe" "/c $runnerCmd"
  nssm install CodexRelayConnector "cmd.exe" "/c $connectorCmd"

  nssm start CodexRelayRunner
  nssm start CodexRelayConnector

  Write-Host "agent install done"
} finally {
  Pop-Location
}
