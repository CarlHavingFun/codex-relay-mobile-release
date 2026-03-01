param(
  [string]$RepoUrl = "https://github.com/CarlHavingFun/codex-relay-mobile-release.git",
  [string]$RepoRef = "main",
  [string]$InstallRoot = "",
  [string]$PlatformBaseUrl = "",
  [string]$PlatformAccessToken = ""
)

$ErrorActionPreference = "Stop"

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $HOME ".codexiphone"
}

$projectDir = Join-Path $InstallRoot "codexiphone"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required. Please install git first."
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

if (Test-Path (Join-Path $projectDir ".git")) {
  Write-Host "[codexiphone-install] updating existing project: $projectDir"
  git -C $projectDir fetch --depth 1 origin $RepoRef
  git -C $projectDir checkout -q FETCH_HEAD
} else {
  if (Test-Path $projectDir) {
    Remove-Item -Path $projectDir -Recurse -Force
  }
  Write-Host "[codexiphone-install] cloning project into: $projectDir"
  git clone --depth 1 --branch $RepoRef $RepoUrl $projectDir
}

$quickGuide = Join-Path $projectDir "deploy/agent/quick_guide.ps1"
if (-not (Test-Path $quickGuide)) {
  throw "missing quick guide script: $quickGuide"
}

Write-Host "[codexiphone-install] starting quick guide installer"
& $quickGuide -PlatformBaseUrl $PlatformBaseUrl -PlatformAccessToken $PlatformAccessToken
