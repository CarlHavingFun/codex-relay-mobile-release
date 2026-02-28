# Codex Relay Mobile (Release Edition)

This repository is the external-user release variant of `codex_iphone`.

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

## One-click entry
Use a single script entry for both mac mini and server:

```bash
# auto mode: macOS => macmini flow, Linux => server flow
./deploy/oneclick.sh auto

# explicit mode
./deploy/oneclick.sh macmini
RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=ops@example.com ./deploy/oneclick.sh server
```

## Public web guide
- Deployed URL: `https://my-agent.com.cn/clawdpet-home/codex-relay-mobile/`
- Publish command:
```bash
npm run deploy:site:my-agent
```

## GitHub download
- Repository: `https://github.com/CarlHavingFun/codex-relay-mobile-release`
- Release package: `https://github.com/CarlHavingFun/codex-relay-mobile-release/releases/tag/v0.1.0`

## iOS signing template (local only)
- Example file: `ios/Config/Signing.local.xcconfig.example`
- Local file to create: `ios/Config/Signing.local.xcconfig` (gitignored)
- `scripts/release_preflight.sh` auto-detects this file and applies `-xcconfig`.

## Runtime defaults
- `DEFAULT_WORKSPACE=default`
- `CONNECTOR_WORKSPACE=default`
- `SERVICE_LABEL_PREFIX=com.yourorg.codexrelay`

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
- `npm run runner:start|stop|status|install-launchd|uninstall-launchd`
- `npm run connector:start|stop|status|install-launchd|uninstall-launchd`

## Docs
- iOS app guide (recommended first read): `ios/IOS_APP_GUIDE.md`
- Public HTML guide source: `docs/site/guide.html`
- mac mini deployment: `docs/deploy/macmini.md`
- Ubuntu relay deployment: `docs/deploy/server-ubuntu22.md`
- App Store release checklist: `docs/appstore/release-checklist.md`
- Non-prod isolated testing: `docs/testing/nonprod-isolated-testing.md`
