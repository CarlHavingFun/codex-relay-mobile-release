param(
  [string]$EnvFile = "",
  [string]$PlatformAccessToken = "",
  [string]$PlatformBaseUrl = ""
)

$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
& (Join-Path $root "deploy/agent/install.ps1") -EnvFile $EnvFile -PlatformAccessToken $PlatformAccessToken -PlatformBaseUrl $PlatformBaseUrl
