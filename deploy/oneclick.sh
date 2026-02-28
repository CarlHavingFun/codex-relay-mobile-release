#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-auto}"

run_macmini() {
  echo "[oneclick] mac mini flow"
  bash "$ROOT/deploy/macmini/install.sh"
  bash "$ROOT/deploy/macmini/init-env.sh"
  bash "$ROOT/deploy/macmini/bootstrap.sh"
  bash "$ROOT/deploy/macmini/doctor.sh"
}

run_server() {
  echo "[oneclick] server flow"
  bash "$ROOT/deploy/server/install_ubuntu22.sh"
  if [[ -n "${RELAY_DOMAIN:-}" && -n "${CERTBOT_EMAIL:-}" ]]; then
    bash "$ROOT/deploy/server/configure_nginx_tls.sh"
  else
    echo "[oneclick] skip TLS auto-step: RELAY_DOMAIN/CERTBOT_EMAIL not set"
  fi
  bash "$ROOT/deploy/server/doctor.sh"
}

usage() {
  cat <<USAGE
Usage:
  ./deploy/oneclick.sh [auto|macmini|server]

Behavior:
  auto    macOS => macmini flow, Linux => server flow
  macmini run install + init-env + bootstrap + doctor
  server  run install + (optional tls) + doctor

Optional env for server mode:
  RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com
USAGE
}

case "$MODE" in
  auto)
    case "$(uname -s)" in
      Darwin) run_macmini ;;
      Linux) run_server ;;
      *)
        echo "Unsupported OS for auto mode: $(uname -s)" >&2
        usage
        exit 1
        ;;
    esac
    ;;
  macmini) run_macmini ;;
  server) run_server ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage
    exit 1
    ;;
esac
