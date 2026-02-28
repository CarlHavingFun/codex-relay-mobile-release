# mac mini Deployment Guide

## Supported baseline
- macOS 14+
- Node.js 20+
- Optional: tmux

## 1) Install prerequisites
```bash
cd /path/to/Codex_Iphone_release
./deploy/macmini/install.sh
```

## 2) Initialize environment
```bash
./deploy/macmini/init-env.sh
```

Required values:
- `RELAY_BASE_URL`: your public relay URL
- `RELAY_TOKEN`: shared bearer token
- `WORKSPACE_PATH`, `PLAN_FILE`: legacy runner compatibility
- `SERVICE_LABEL_PREFIX`: launchd label prefix (`com.yourorg.codexrelay` by default)

## 3) Start services
```bash
./deploy/macmini/bootstrap.sh
```

This installs and starts:
- `${SERVICE_LABEL_PREFIX}.runner`
- `${SERVICE_LABEL_PREFIX}.chatconnector`

## 4) Run health checks
```bash
./deploy/macmini/doctor.sh
```

## Troubleshooting
- Launchd status:
  - `npm run runner:status`
  - `npm run connector:status`
- Restart:
  - `npm run runner:stop && npm run runner:start`
  - `npm run connector:stop && npm run connector:start`
- Reinstall launchd services:
  - `npm run runner:uninstall-launchd && npm run runner:install-launchd`
  - `npm run connector:uninstall-launchd && npm run connector:install-launchd`
