#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DB="${1:-$ROOT/relay/data/relay.db}"
DST_DB="${2:-$HOME/codex_iphone_control_tower/relay/data/relay.db}"

if [ ! -f "$SRC_DB" ]; then
  echo "source db not found: $SRC_DB" >&2
  exit 1
fi

if [ ! -f "$DST_DB" ]; then
  echo "target db not found: $DST_DB" >&2
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_DB="${DST_DB%.db}.backup_${TS}.db"

count_sql() {
  cat <<'SQL'
SELECT 'chat_threads',COUNT(*) FROM chat_threads
UNION ALL SELECT 'chat_jobs',COUNT(*) FROM chat_jobs
UNION ALL SELECT 'chat_events',COUNT(*) FROM chat_events
UNION ALL SELECT 'events',COUNT(*) FROM events
UNION ALL SELECT 'tasks_current',COUNT(*) FROM tasks_current
UNION ALL SELECT 'approvals',COUNT(*) FROM approvals
UNION ALL SELECT 'connector_session_sync_requests',COUNT(*) FROM connector_session_sync_requests
UNION ALL SELECT 'connector_auth_relogin_requests',COUNT(*) FROM connector_auth_relogin_requests
UNION ALL SELECT 'session_backfill_runs',COUNT(*) FROM session_backfill_runs;
SQL
}

echo "[sync] source: $SRC_DB"
echo "[sync] target: $DST_DB"

echo "[sync] source counts (before):"
sqlite3 "$SRC_DB" "$(count_sql)"

echo "[sync] target counts (before):"
sqlite3 "$DST_DB" "$(count_sql)"

echo "[sync] backup target -> $BACKUP_DB"
sqlite3 -cmd "PRAGMA busy_timeout=30000;" "$DST_DB" ".backup '$BACKUP_DB'"

sqlite3 "$DST_DB" <<SQL
PRAGMA busy_timeout=30000;
ATTACH '$SRC_DB' AS src;
BEGIN;

INSERT OR REPLACE INTO chat_threads (
  thread_id, workspace, title, external_thread_id, source, status, created_at, updated_at
)
SELECT
  thread_id, workspace, title, external_thread_id, source, status, created_at, updated_at
FROM src.chat_threads;

INSERT OR REPLACE INTO chat_jobs (
  job_id, thread_id, workspace, input_text, policy_json, status, connector_id, turn_id,
  idempotency_key, error_code, error_message, created_at, updated_at,
  input_items_json, stop_requested_at, stop_requested_by
)
SELECT
  job_id, thread_id, workspace, input_text, policy_json, status, connector_id, turn_id,
  idempotency_key, error_code, error_message, created_at, updated_at,
  input_items_json, stop_requested_at, stop_requested_by
FROM src.chat_jobs;

INSERT OR REPLACE INTO chat_events (
  thread_id, seq, workspace, job_id, turn_id, type, delta, payload_json, ts
)
SELECT
  thread_id, seq, workspace, job_id, turn_id, type, delta, payload_json, ts
FROM src.chat_events;

INSERT OR REPLACE INTO events (
  id, runner_id, workspace, task_id, level, phase, message, payload_json, ts
)
SELECT
  id, runner_id, workspace, task_id, level, phase, message, payload_json, ts
FROM src.events;

INSERT OR REPLACE INTO tasks_current (
  workspace, task_id, task_text, task_mode, status, updated_at
)
SELECT
  workspace, task_id, task_text, task_mode, status, updated_at
FROM src.tasks_current;

INSERT OR REPLACE INTO approvals (
  id, runner_id, workspace, task_id, task_text, risk_reason_json,
  state, decision_by, decision_at, created_at, updated_at
)
SELECT
  id, runner_id, workspace, task_id, task_text, risk_reason_json,
  state, decision_by, decision_at, created_at, updated_at
FROM src.approvals;

INSERT OR REPLACE INTO connector_session_sync_requests (
  request_id, workspace, thread_id, requested_by, status,
  connector_id, error, created_at, claimed_at, completed_at
)
SELECT
  request_id, workspace, thread_id, requested_by, status,
  connector_id, error, created_at, claimed_at, completed_at
FROM src.connector_session_sync_requests;

INSERT OR REPLACE INTO connector_auth_relogin_requests (
  request_id, workspace, requested_by, status, connector_id,
  auth_url, user_code, verification_uri_complete, expires_at,
  message, error, created_at, claimed_at, completed_at, updated_at
)
SELECT
  request_id, workspace, requested_by, status, connector_id,
  auth_url, user_code, verification_uri_complete, expires_at,
  message, error, created_at, claimed_at, completed_at, updated_at
FROM src.connector_auth_relogin_requests;

INSERT OR REPLACE INTO session_backfill_runs (
  run_id, workspace, status, scanned_count, imported_count,
  started_at, completed_at, error
)
SELECT
  run_id, workspace, status, scanned_count, imported_count,
  started_at, completed_at, error
FROM src.session_backfill_runs;

COMMIT;
DETACH src;
SQL

echo "[sync] target counts (after):"
sqlite3 "$DST_DB" "$(count_sql)"

echo "[sync] done"
echo "[sync] backup file: $BACKUP_DB"
