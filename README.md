# CodexIPhone (Release Edition)

This repository is the external-user release variant of `codex_iphone`.

## Local Development Rule (This Machine)
- Source-of-truth code edits must be made in this repo path:
  - `/Volumes/M2_Ext/Projects/Codex_Iphone_release`
- Use `/Volumes/M2_Ext/Projects/Codex_Xcode_Migrated/Users/Carl/Desktop/codex_iphone` only as a mirror unless explicitly requested.

## Goals
- Keep relay/connector API semantics and compatibility unchanged.
- Remove personal machine coupling and private identifiers.
- Support self-hosted deployment for external users:
  - iOS app client
  - mac mini connector/runner scripts
  - public relay server scripts

## Directory overview
- `ios/`: App Store-targeted iOS app (`CodexIPhoneApp` scheme).
- `runner/`: desktop connector + legacy runner runtime.
- `relay/`: HTTP relay API (SQLite backend).
- `control-plane/`: optional control-plane service.
- `deploy/macmini/`: one-click setup scripts for mac mini.
- `deploy/server/`: Ubuntu 22.04 deployment scripts for public relay.
- `docs/`: deployment and App Store release docs.

## Quick start (self-hosted)

### Hard prerequisites
- You must deploy your own public Relay server.
- You must keep one Codex-capable desktop/Mac device signed in and running connector/runner in real time.

If either requirement is missing, the iOS app cannot complete the full relay workflow.

### 1) mac mini (desktop side)
```bash
npm run deploy:macmini:install
npm run deploy:macmini:init-env
npm run deploy:macmini:bootstrap
npm run deploy:macmini:doctor
```

### 2) Ubuntu public relay
```bash
npm run deploy:server:install:ubuntu22
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com npm run deploy:server:nginx-tls
RELAY_DOMAIN=relay.example.com npm run deploy:server:doctor
```

### 3) iOS app
```bash
cd ios
xcodegen generate
open CodexIPhone.xcodeproj
```

In app first launch:
1. Input `Relay Base URL`.
2. Input `Bearer Token`.
3. Keep workspace `*` or set a fixed workspace.

Optional (recommended): generate setup QR and scan with iPhone Camera to auto-fill.
```bash
npm run relay:setup:qr
```
Default output: `state/relay_setup/relay_setup_qr.png` (contains token, handle as secret).

## One-click entry
Use a single script entry for both mac mini and server:

```bash
# auto mode: macOS => macmini flow, Linux => server flow
./deploy/oneclick.sh auto

# explicit mode
./deploy/oneclick.sh macmini
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/oneclick.sh server
```

## CodexIPhone Quick Guide (single script on user computer)
For hosted multi-tenant onboarding on a user computer, run:

```bash
./deploy/agent/quick_guide.sh
```

What it does automatically:
- Detect/install `node` + `npm` (best effort by OS)
- Detect/install `codex` CLI (`@openai/codex`)
- Auto-generate unique secure secrets in `config/.env` when missing:
  - `RELAY_TOKEN`
  - `PLATFORM_JWT_SECRET`
- Check `codex login status` and auto-trigger login (`--device-auth` or `--with-api-key`)
- Start local `platform-api` (with migration) when `PLATFORM_BASE_URL` is local
- Generate pairing QR, wait mobile scan/confirm, claim unique connector token
- Install/start runner + connector services
- Run doctor checks automatically

## Public web guide
- Deployed URL: `https://my-agent.com.cn/codexiphone/`
- Publish command:
```bash
npm run deploy:site:codexiphone
```

## CodexIPhone Domain Prefix Installer
- Dedicated guide path: `https://my-agent.com.cn/codexiphone/`
- Installer URLs:
  - `https://my-agent.com.cn/codexiphone/install.sh`
  - `https://my-agent.com.cn/codexiphone/install.ps1`
- Publish command:
```bash
npm run deploy:site:codexiphone
```
- User one-liner (macOS/Linux):
```bash
curl -fsSL https://my-agent.com.cn/codexiphone/install.sh | bash
```

## GitHub download
- Repository: `https://github.com/CarlHavingFun/codex-relay-mobile-release`
- Release package: `https://github.com/CarlHavingFun/codex-relay-mobile-release/releases/latest`

## iOS signing template (local only)
- Example file: `ios/Config/Signing.local.xcconfig.example`
- Local file to create: `ios/Config/Signing.local.xcconfig` (gitignored)
- `scripts/release_preflight.sh` auto-detects this file and applies `-xcconfig`.

## Runtime defaults
- `DEFAULT_WORKSPACE=codex_iphone`
- `CONNECTOR_WORKSPACE=codex_iphone`
- `SERVICE_LABEL_PREFIX=com.carl.codexiphone`

Launchd labels become:
- `${SERVICE_LABEL_PREFIX}.runner`
- `${SERVICE_LABEL_PREFIX}.chatconnector`

## API compatibility note
Relay endpoints and fallback compatibility are unchanged:
- primary prefixes: `/legacy-runner/*`, `/codex-iphone-connector/*`
- compatibility aliases: `/v1/*`, `/v2/*`

## Key commands
- `npm run connector:test`
- `npm run control-plane:test`
- `npm run release:preflight`
- `npm run deploy:smoke:macmini|server`
- `npm run deploy:smoke:teardown:macmini|server`
- `npm run runner:start|stop|status|install-launchd|uninstall-launchd`
- `npm run connector:start|stop|status|install-launchd|uninstall-launchd`

## Docs
- iOS app guide (recommended first read): `ios/IOS_APP_GUIDE.md`
- Public HTML guide source: `docs/site/codexiphone/index.html`
- mac mini deployment: `docs/deploy/macmini.md`
- Ubuntu relay deployment: `docs/deploy/server-ubuntu22.md`
- App Store release checklist: `docs/appstore/release-checklist.md`
- Non-prod isolated testing: `docs/testing/nonprod-isolated-testing.md`
