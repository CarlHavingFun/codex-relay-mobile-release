#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEXIPHONE_REPO_URL:-https://github.com/CarlHavingFun/codex-relay-mobile-release.git}"
REPO_REF="${CODEXIPHONE_REPO_REF:-main}"
INSTALL_ROOT="${CODEXIPHONE_INSTALL_ROOT:-$HOME/.codexiphone}"
PROJECT_DIR="${INSTALL_ROOT%/}/codexiphone"

log() {
  echo "[codexiphone-install] $*"
}

need_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    return
  fi
  echo "[codexiphone-install] ERROR: missing command: $cmd" >&2
  exit 1
}

sync_repo() {
  mkdir -p "$INSTALL_ROOT"

  if [[ -d "$PROJECT_DIR/.git" ]]; then
    log "updating existing project: $PROJECT_DIR"
    git -C "$PROJECT_DIR" fetch --depth 1 origin "$REPO_REF"
    git -C "$PROJECT_DIR" checkout -q FETCH_HEAD
    return
  fi

  if [[ -d "$PROJECT_DIR" ]]; then
    rm -rf "$PROJECT_DIR"
  fi

  log "cloning project into: $PROJECT_DIR"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$PROJECT_DIR"
}

main() {
  need_cmd git
  need_cmd bash

  sync_repo
  cd "$PROJECT_DIR"

  log "starting quick guide installer"
  bash "$PROJECT_DIR/deploy/agent/quick_guide.sh" "$@"
}

main "$@"
