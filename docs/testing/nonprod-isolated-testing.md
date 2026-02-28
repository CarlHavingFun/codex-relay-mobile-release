# Non-Prod Isolated Testing (No impact on current prod)

## Goal
Run a full end-to-end test without touching your current production relay/mac setup.

## Fast setup scripts
- mac mini staging (same machine): `npm run deploy:smoke:macmini`
- server staging (same machine): `npm run deploy:smoke:server`

## Fast teardown scripts
- mac mini staging cleanup: `npm run deploy:smoke:teardown:macmini`
- server staging cleanup: `npm run deploy:smoke:teardown:server`
- remove files/dirs too:
  - `CLEAN_STATE=1 npm run deploy:smoke:teardown:macmini`
  - `CLEAN_INSTALL_DIR=1 npm run deploy:smoke:teardown:server`

## Isolation principle
- Different service name
- Different listen port
- Different token
- Different launchd label prefix
- Different state directory

## Server side (same machine)
1. Duplicate install dir to `/opt/codex_relay_mobile_staging`.
2. Use separate env file (`config/.env.staging`) with:
   - `RELAY_PORT=8794`
   - `DEFAULT_WORKSPACE=staging`
   - unique `RELAY_TOKEN`
3. Register `codex-relay-staging.service`.
4. Expose only under subpath `/codex-relay-staging/` in nginx.

## mac side (same machine)
Use a separate env with:
- `SERVICE_LABEL_PREFIX=com.yourorg.codexrelay.staging`
- `STATE_DIR=/path/to/Codex_Iphone_release/state_staging`
- `CONNECTOR_WORKSPACE=staging`
- `RELAY_BASE_URL=https://my-agent.com.cn/codex-relay-staging`
- staging token

This keeps existing launchd services and state untouched.

## iOS side
Create a separate profile in app settings:
- Base URL = staging URL
- Token = staging token
- Workspace = `staging`

## Rollback
- Stop and disable `codex-relay-staging`
- Remove staging nginx location
- Remove staging launchd services by staging label prefix
- Keep prod services running throughout
