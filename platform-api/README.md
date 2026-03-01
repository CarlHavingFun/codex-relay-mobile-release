# Platform API

Multi-tenant auth/pairing/bootstrap service for hosted Codex relay.

## Required env

- `PLATFORM_DATABASE_URL` (PostgreSQL DSN)
- `PLATFORM_JWT_SECRET`
- `PLATFORM_RELAY_BASE_URL`

Optional:

- `PLATFORM_API_PORT` (default `8791`)
- `PLATFORM_DEV_MODE=1` (returns OTP code in response for local testing)
- `PLATFORM_PUBLIC_BASE_URL` (used in QR deep link `platform_base_url` field)
- `PLATFORM_PAIRING_START_REQUIRE_MOBILE_AUTH=1` (lock `/v1/pairing/desktop/start` behind mobile auth)

## Run

```bash
node platform-api/migrate.js
node platform-api/server.js
```

## API

- `POST /v1/auth/email/send-code`
- `POST /v1/auth/email/verify`
- `POST /v1/auth/refresh`
- `POST /v1/pairing/desktop/start`
- `POST /v1/pairing/desktop/confirm`
- `POST /v1/pairing/desktop/claim`
- `GET /v1/bootstrap/mobile`
- `POST /v1/migration/import`

Pairing notes:
- `/v1/pairing/desktop/start` now supports anonymous desktop start by default (no Authorization header required).
- If `PLATFORM_PAIRING_START_REQUIRE_MOBILE_AUTH=1`, desktop start requires a mobile JWT.
