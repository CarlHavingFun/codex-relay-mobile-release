# Ubuntu 22.04 Relay Deployment Guide

## Supported baseline
- Ubuntu 22.04
- Public ports: `80` and `443`
- Relay internal port: `127.0.0.1:8787` only

## 1) Install relay service
```bash
cd /path/to/Codex_Iphone_release
INSTALL_DIR=/opt/codexiphone RUN_USER=codexrelay ./deploy/server/install_ubuntu22.sh
```

What it does:
- installs Node.js 20+
- creates non-root runtime user
- syncs repo to `INSTALL_DIR`
- renders `/etc/systemd/system/codex-relay.service` from template
- installs watchdog timer (`codex-relay-watchdog.timer`) for health auto-restart
- starts `codex-relay`

## 2) Configure HTTPS reverse proxy
```bash
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/server/configure_nginx_tls.sh
```

## 3) Verify
```bash
RELAY_DOMAIN=relay.example.com ./deploy/server/doctor.sh
```

## 4) Create admin account (owner role)

```bash
PLATFORM_DATABASE_URL="postgres://codex:codex@127.0.0.1:55432/codex_platform" \
npm run platform-api:create-admin -- --email admin@example.com --tenant-name admin
```

Note:
- Hosted auth uses email OTP flow (no static password).
- The created account is a tenant membership with `role=owner`.

Watchdog status check:

```bash
sudo systemctl status codex-relay-watchdog.timer --no-pager
sudo systemctl status codex-relay-watchdog.service --no-pager
```

Failure auto-restart test:

```bash
sudo systemctl kill -s SIGKILL codex-relay
# wait 1-3 minutes
sudo systemctl status codex-relay --no-pager
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
