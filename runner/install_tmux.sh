#!/usr/bin/env bash
set -euo pipefail
if command -v tmux >/dev/null 2>&1; then
  echo "tmux already installed: $(tmux -V)"
  exit 0
fi
brew install tmux
