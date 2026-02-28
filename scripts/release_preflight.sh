#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SIGNING_XCCONFIG="$ROOT/ios/Config/Signing.local.xcconfig"

run_xcodebuild() {
  if [ -f "$SIGNING_XCCONFIG" ]; then
    xcodebuild "$@" -xcconfig "$SIGNING_XCCONFIG"
  else
    xcodebuild "$@"
  fi
}

echo "[1/4] connector unit tests"
npm run connector:test

echo "[2/4] generate Xcode project"
(
  cd ios
  xcodegen generate >/dev/null
)

echo "[3/4] build iOS app for simulator"
run_xcodebuild \
  -project ios/CodexIPhone.xcodeproj \
  -scheme CodexIPhoneApp \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build >/dev/null

echo "[4/4] build iOS app for device"
run_xcodebuild \
  -project ios/CodexIPhone.xcodeproj \
  -scheme CodexIPhoneApp \
  -configuration Release \
  -destination "generic/platform=iOS" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build >/dev/null

echo "preflight passed"
