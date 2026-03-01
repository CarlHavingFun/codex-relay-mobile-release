param(
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "../..")
if (-not $EnvFile) { $EnvFile = Join-Path $Root "config/.env" }
if (-not (Test-Path $EnvFile)) { throw "missing env file: $EnvFile" }

$envMap = @{}
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match "^\s*#") { return }
  if ($_ -match "^\s*$") { return }
  $idx = $_.IndexOf("=")
  if ($idx -lt 1) { return }
  $k = $_.Substring(0, $idx).Trim()
  $v = $_.Substring($idx + 1).Trim()
  $envMap[$k] = $v
}

if (-not $envMap.ContainsKey("RELAY_BASE_URL")) { throw "RELAY_BASE_URL missing" }
if (-not $envMap.ContainsKey("RELAY_TOKEN")) { throw "RELAY_TOKEN missing" }

$base = $envMap["RELAY_BASE_URL"].TrimEnd('/')
$token = $envMap["RELAY_TOKEN"]

Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing | Out-Null
Invoke-WebRequest -Uri "$base/codex-iphone-connector/status?workspace=*" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing | Out-Null

$runner = Get-Service -Name CodexRelayRunner -ErrorAction SilentlyContinue
$connector = Get-Service -Name CodexRelayConnector -ErrorAction SilentlyContinue
if (-not $runner -or $runner.Status -ne 'Running') { throw "CodexRelayRunner not running" }
if (-not $connector -or $connector.Status -ne 'Running') { throw "CodexRelayConnector not running" }

Write-Host "doctor passed"
