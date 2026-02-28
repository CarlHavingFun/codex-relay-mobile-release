# Agent Control Plane

Workflow-orchestrated control plane for 7x24 autonomous execution.

## Goals
- Keep existing `codex-iphone` flow untouched by default.
- Add durable orchestration (`queued -> planning -> running -> reviewing -> releasing -> done/failed/rolled_back`).
- Support parallel sub-agent execution with retry, circuit breaker, and rollback.

## Runtime
- Start: `npm run control-plane:start`
- Status: `npm run control-plane:status`
- Stop: `npm run control-plane:stop`
- Run in foreground: `npm run control-plane:run`

## Env
- `CONTROL_PLANE_PORT` (default `8790`)
- `CONTROL_PLANE_GLOBAL_PARALLELISM` (default `10`)
- `CONTROL_PLANE_TASK_PARALLELISM` (default `8`)
- `CONTROL_PLANE_LOOP_MS` (default `1000`)
- `CONTROL_PLANE_CIRCUIT_THRESHOLD` (default `3`)
- `CONTROL_PLANE_TOKEN` (optional; falls back to `RELAY_TOKEN`)

## API Prefix
- Native: `http://127.0.0.1:8790/agent-control-plane/v1/*`
- Relay proxy: `http://relay-host:8787/agent-control-plane/v1/*`

## Notes
- Uses isolated SQLite DB: `control-plane/data/control_plane.db`.
- Relay proxy for this API is disabled unless `CONTROL_PLANE_ENABLED=1`.

## Relay Bridge Worker
This worker bridges Control Plane dispatched jobs into existing Relay/Connector chat execution.

### Commands
- `npm run control-plane:bridge:start`
- `npm run control-plane:bridge:status`
- `npm run control-plane:bridge:stop`
- `npm run control-plane:bridge:run`

### Flow
1. Claim dispatched jobs from Control Plane (`/agent-control-plane/v1/worker/jobs/claim`).
2. Create/update Relay chat thread (`/codex-iphone-connector/chat/threads`).
3. Send prompt to Relay chat message endpoint (`/codex-iphone-connector/chat/threads/:thread_id/messages`).
4. Poll Relay job status and report result to Control Plane (`/agent-control-plane/v1/events/worker-result`).
