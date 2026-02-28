#!/usr/bin/env bash
set -euo pipefail

RELAY_DOMAIN="${RELAY_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NGINX_SITE="/etc/nginx/sites-available/codex-relay-mobile"
NGINX_LINK="/etc/nginx/sites-enabled/codex-relay-mobile"

if [[ -z "$RELAY_DOMAIN" || -z "$CERTBOT_EMAIL" ]]; then
  echo "Set RELAY_DOMAIN and CERTBOT_EMAIL first." >&2
  echo "Example: RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/server/configure_nginx_tls.sh"
  exit 1
fi

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Run as root or install sudo." >&2
    exit 1
  fi
fi

$SUDO apt-get update -y
$SUDO apt-get install -y nginx certbot python3-certbot-nginx

$SUDO tee "$NGINX_SITE" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${RELAY_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

$SUDO rm -f /etc/nginx/sites-enabled/default
$SUDO ln -sf "$NGINX_SITE" "$NGINX_LINK"
$SUDO nginx -t
$SUDO systemctl reload nginx

$SUDO certbot --nginx -d "$RELAY_DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect

echo "TLS setup completed for $RELAY_DOMAIN"
echo "Verify: https://$RELAY_DOMAIN/healthz"
