param(
  [string]$EnvFile = "",
  [string]$PlatformAccessToken = "",
  [string]$PlatformBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "../..")
if (-not $EnvFile) { $EnvFile = Join-Path $Root "config/.env" }
if (-not $PlatformAccessToken) { $PlatformAccessToken = $env:PLATFORM_ACCESS_TOKEN }
if (-not $PlatformBaseUrl) {
  if ($env:PLATFORM_BASE_URL) { $PlatformBaseUrl = $env:PLATFORM_BASE_URL }
  elseif ($env:PLATFORM_API_BASE_URL) { $PlatformBaseUrl = $env:PLATFORM_API_BASE_URL }
  else { $PlatformBaseUrl = "http://127.0.0.1:8791" }
}

function Ensure-EnvFile {
  if (Test-Path $EnvFile) { return }
  $template = Join-Path $Root "config/.env.example"
  if (Test-Path $template) {
    Copy-Item $template $EnvFile
  } else {
    New-Item -ItemType File -Path $EnvFile | Out-Null
  }
}

function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
  if (-not $line) { return "" }
  return $line.Substring($Key.Length + 1)
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path $EnvFile) { $lines = Get-Content $EnvFile }
  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$Key=") {
      $lines[$i] = "$Key=$Value"
      $updated = $true
    }
  }
  if (-not $updated) { $lines += "$Key=$Value" }
  Set-Content -Path $EnvFile -Value $lines
}

function Ensure-Secret([string]$Key, [int]$Bytes = 32) {
  $v = Get-EnvValue $Key
  if ($v) { return }
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buf)
  $hex = -join ($buf | ForEach-Object { $_.ToString("x2") })
  Set-EnvValue $Key $hex
  Write-Host "[agent-install] generated secret: $Key"
}

function Ensure-Codex {
  if (Get-Command codex -ErrorAction SilentlyContinue) { return }
  Write-Host "[agent-install] codex missing, installing @openai/codex ..."
  npm install -g @openai/codex
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw "codex install failed"
  }
}

function Ensure-CodexLogin {
  $status = (& codex login status 2>&1 | Out-String)
  if ($status -match "Logged in") {
    Write-Host "[agent-install] codex login status: logged in"
    return
  }

  Write-Host "[agent-install] codex login required"
  if ($env:OPENAI_API_KEY) {
    $env:OPENAI_API_KEY | codex login --with-api-key | Out-Null
  } else {
    codex login --device-auth
  }

  $status2 = (& codex login status 2>&1 | Out-String)
  if ($status2 -notmatch "Logged in") {
    throw "codex login status not ready: $status2"
  }
}

function Start-LocalPlatformApiIfNeeded {
  if ($PlatformBaseUrl -notmatch "^https?://(127.0.0.1|localhost):") {
    Write-Host "[agent-install] using remote platform API: $PlatformBaseUrl"
    return
  }

  $db = $env:PLATFORM_DATABASE_URL
  if (-not $db) { $db = Get-EnvValue "PLATFORM_DATABASE_URL" }
  if (-not $db) {
    throw "PLATFORM_DATABASE_URL missing for local platform-api on Windows"
  }

  $relayBase = $env:PLATFORM_RELAY_BASE_URL
  if (-not $relayBase) { $relayBase = Get-EnvValue "PLATFORM_RELAY_BASE_URL" }
  if (-not $relayBase) {
    $relayBase = Get-EnvValue "RELAY_BASE_URL"
    if ($relayBase) { Set-EnvValue "PLATFORM_RELAY_BASE_URL" $relayBase }
  }
  if (-not $relayBase) {
    throw "RELAY_BASE_URL missing; cannot infer PLATFORM_RELAY_BASE_URL"
  }

  $env:CONFIG_ENV_FILE = $EnvFile
  npm --prefix $Root run platform-api:migrate

  $healthz = "$($PlatformBaseUrl.TrimEnd('/'))/healthz"
  try {
    Invoke-WebRequest -Uri $healthz -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-Host "[agent-install] local platform-api already running"
    return
  } catch {}

  $stateDir = Join-Path $Root "state/platform-api"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $logFile = Join-Path $stateDir "platform-api.log"
  $cmd = "cd /d $Root && set CONFIG_ENV_FILE=$EnvFile && node platform-api/server.js >> `"$logFile`" 2>&1"
  Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c $cmd" | Out-Null

  Start-Sleep -Seconds 2
  Invoke-WebRequest -Uri $healthz -UseBasicParsing -TimeoutSec 15 | Out-Null
  Write-Host "[agent-install] local platform-api started"
}

Ensure-EnvFile
Ensure-Secret "RELAY_TOKEN" 32
Ensure-Secret "PLATFORM_JWT_SECRET" 32

Push-Location $Root
try {
  npm ci
  Ensure-Codex
  Ensure-CodexLogin

  Start-LocalPlatformApiIfNeeded

  if ($PlatformAccessToken) {
    node scripts/desktop-pairing.mjs --start --platform-base-url $PlatformBaseUrl --access-token $PlatformAccessToken --env-file $EnvFile
  } else {
    node scripts/desktop-pairing.mjs --start --platform-base-url $PlatformBaseUrl --env-file $EnvFile
  }
  node scripts/desktop-pairing.mjs --wait --platform-base-url $PlatformBaseUrl --env-file $EnvFile

  if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "nssm not found. Please install NSSM and rerun to register Windows services."
    exit 1
  }

  $runnerCmd = "cd /d $Root && set CONFIG_ENV_FILE=$EnvFile && node runner/runner.js"
  $connectorCmd = "cd /d $Root && set CONFIG_ENV_FILE=$EnvFile && node runner/chat_connector.js"

  nssm install CodexRelayRunner "cmd.exe" "/c $runnerCmd"
  nssm install CodexRelayConnector "cmd.exe" "/c $connectorCmd"
  nssm start CodexRelayRunner
  nssm start CodexRelayConnector

  powershell -ExecutionPolicy Bypass -File (Join-Path $Root "deploy/agent/doctor.ps1") -EnvFile $EnvFile
  Write-Host "agent quick guide done"
} finally {
  Pop-Location
}
