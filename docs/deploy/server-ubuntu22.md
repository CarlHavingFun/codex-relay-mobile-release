# Ubuntu 22.04 Relay Deployment Guide

## Supported baseline
- Ubuntu 22.04
- Public ports: `80` and `443`
- Relay internal port: `127.0.0.1:8787` only

## 1) Install relay service
```bash
cd /path/to/Codex_Iphone_release
INSTALL_DIR=/opt/codex_relay_mobile RUN_USER=codexrelay ./deploy/server/install_ubuntu22.sh
```

What it does:
- installs Node.js 20+
- creates non-root runtime user
- syncs repo to `INSTALL_DIR`
- renders `/etc/systemd/system/codex-relay.service` from template
- starts `codex-relay`

## 2) Configure HTTPS reverse proxy
```bash
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/server/configure_nginx_tls.sh
```

## 3) Verify
```bash
RELAY_DOMAIN=relay.example.com ./deploy/server/doctor.sh
```

## Security checks
- Relay process runs as non-root user (`RUN_USER`).
- Relay listens on loopback (`127.0.0.1:8787`).
- Only Nginx is exposed publicly on `80/443`.
- `RELAY_TOKEN` must not be placeholder value.

## Rollback
```bash
sudo systemctl stop codex-relay
sudo systemctl disable codex-relay
sudo rm -f /etc/systemd/system/codex-relay.service
sudo systemctl daemon-reload
```
