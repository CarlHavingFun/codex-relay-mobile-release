# Relay deployment (Ubuntu 22.04)

Use the server deployment scripts from the repo root.

## 1) Install relay service

```bash
cd /path/to/Codex_Iphone_release
INSTALL_DIR=/opt/codex_relay_mobile RUN_USER=codexrelay ./deploy/server/install_ubuntu22.sh
```

This script:
- installs Node.js 20+
- creates a non-root service user
- syncs repo files into `INSTALL_DIR`
- renders `/etc/systemd/system/codex-relay.service` from `relay/deploy/codex-relay.service`
- enables and starts the service

## 2) Configure Nginx + TLS

```bash
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/server/configure_nginx_tls.sh
```

## 3) Verify

```bash
RELAY_DOMAIN=relay.example.com ./deploy/server/doctor.sh
```

Direct local check:

```bash
curl -H "Authorization: Bearer <RELAY_TOKEN>" "http://127.0.0.1:8787/legacy-runner/status?workspace=default"
```
