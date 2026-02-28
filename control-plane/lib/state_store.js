const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  nowIso,
  randomId,
  parseJson,
  clampInt,
} = require('./common');
const {
  isCriticalRole,
  isHighRiskJob,
  nextRunAtFromAttempt,
  canDispatchHighRisk,
} = require('./policy_risk');

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'timeout', 'canceled']);
const ACTIVE_JOB_STATUSES = new Set(['blocked', 'queued', 'dispatched', 'claimed', 'running']);
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'rolled_back', 'canceled']);

function normalizePriority(value) {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'P0' || v === 'P1' || v === 'P2') return v;
  return 'P1';
}

function normalizeRiskProfile(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return 'medium';
}

function normalizeWorkerResultStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['completed', 'complete', 'success', 'succeeded', 'ok'].includes(v)) return 'completed';
  if (['failed', 'fail', 'error'].includes(v)) return 'failed';
  if (['timeout', 'timed_out'].includes(v)) return 'timeout';
  if (['interrupted', 'aborted', 'stopped', 'canceled', 'cancelled'].includes(v)) return 'canceled';
  return 'failed';
}

function safeArray(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((item) => String(item == null ? '' : item).trim())
    .filter((item) => item.length > 0);
}

class StateStore {
  constructor(opts = {}) {
    const dbPath = opts.dbPath || path.join(__dirname, '..', 'data', 'control_plane.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.dbPath = dbPath;
    this.globalParallelism = clampInt(opts.globalParallelism, 1, 20, 10);
    this.defaultTaskParallelism = clampInt(opts.defaultTaskParallelism, 1, 10, 8);
    this.circuitThreshold = clampInt(opts.circuitThreshold, 1, 20, 3);

    this.db = new DatabaseSync(dbPath);
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  priority TEXT NOT NULL,
  risk_profile TEXT NOT NULL,
  status TEXT NOT NULL,
  parallelism_limit INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failed_reason TEXT,
  degraded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at ASC);

CREATE TABLE IF NOT EXISTS task_plans (
  task_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timeout_s INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  worker_id TEXT,
  depends_on_json TEXT NOT NULL,
  next_run_at TEXT,
  last_error TEXT,
  artifacts_json TEXT,
  logs_json TEXT,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_task_status_updated ON jobs(task_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run_at, created_at ASC);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id, id DESC);

CREATE TABLE IF NOT EXISTS decision_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_records_task_id ON decision_records(task_id, id DESC);

CREATE TABLE IF NOT EXISTS rollback_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  status TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rollback_records_task_id ON rollback_records(task_id, id DESC);

CREATE TABLE IF NOT EXISTS system_controls (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS circuit_breakers (
  scope TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  opened_at TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);
`);

    const ts = nowIso();
    this.db.prepare(`
INSERT INTO system_controls (key, value_json, updated_at)
VALUES ('emergency_stop', ?, ?)
ON CONFLICT(key) DO NOTHING
`).run(JSON.stringify({ active: false, by: null, reason: null, at: null }), ts);

    this.db.prepare(`
INSERT INTO circuit_breakers (scope, status, failure_count, threshold, opened_at, reason, updated_at)
VALUES ('global', 'closed', 0, ?, NULL, NULL, ?)
ON CONFLICT(scope) DO NOTHING
`).run(this.circuitThreshold, ts);
  }

  _withTx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  _normalizeTask(row) {
    if (!row) return null;
    return {
      task_id: row.task_id,
      goal: row.goal,
      repo: row.repo,
      branch: row.branch,
      acceptance_criteria: parseJson(row.acceptance_criteria_json, []),
      priority: row.priority,
      risk_profile: row.risk_profile,
      status: row.status,
      parallelism_limit: Number(row.parallelism_limit || this.defaultTaskParallelism),
      metadata: parseJson(row.metadata_json, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      failed_reason: row.failed_reason,
      degraded: !!row.degraded,
    };
  }

  _normalizeJob(row) {
    if (!row) return null;
    return {
      job_id: row.job_id,
      task_id: row.task_id,
      node_id: row.node_id,
      role: row.role,
      payload: parseJson(row.payload_json, {}),
      timeout_s: Number(row.timeout_s || 0),
      max_retries: Number(row.max_retries || 0),
      attempt: Number(row.attempt || 0),
      status: row.status,
      worker_id: row.worker_id,
      depends_on: parseJson(row.depends_on_json, []),
      next_run_at: row.next_run_at,
      last_error: row.last_error,
      artifacts: parseJson(row.artifacts_json, null),
      logs: parseJson(row.logs_json, null),
      metrics: parseJson(row.metrics_json, null),
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
    };
  }

  _recordTaskEvent(taskId, eventType, payload = null, ts = nowIso()) {
    this.db.prepare(`
INSERT INTO task_events (task_id, event_type, payload_json, ts)
VALUES (?, ?, ?, ?)
`).run(taskId, eventType, payload == null ? null : JSON.stringify(payload), ts);
  }

  _recordDecision(taskId, decision, reason, evidence = null, ts = nowIso()) {
    this.db.prepare(`
INSERT INTO decision_records (task_id, decision, reason, evidence_json, ts)
VALUES (?, ?, ?, ?, ?)
`).run(
      taskId,
      String(decision || '').slice(0, 120),
      String(reason || '').slice(0, 500),
      evidence == null ? null : JSON.stringify(evidence),
      ts,
    );
  }

  _taskRow(taskId) {
    return this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId);
  }

  _jobsForTaskRows(taskId) {
    return this.db.prepare(`
SELECT * FROM jobs
WHERE task_id = ?
ORDER BY created_at ASC
`).all(taskId);
  }

  _activeJobsCountByTask(taskIds = null) {
    const whereClause = taskIds && taskIds.length
      ? `AND task_id IN (${taskIds.map(() => '?').join(',')})`
      : '';
    const rows = this.db.prepare(`
SELECT task_id, COUNT(*) AS count
FROM jobs
WHERE status IN ('dispatched', 'claimed', 'running')
${whereClause}
GROUP BY task_id
`).all(...(taskIds || []));

    const out = new Map();
    for (const row of rows) out.set(String(row.task_id), Number(row.count || 0));
    return out;
  }

  _globalActiveJobsCount() {
    const row = this.db.prepare(`
SELECT COUNT(*) AS count
FROM jobs
WHERE status IN ('dispatched', 'claimed', 'running')
`).get();
    return Number(row?.count || 0);
  }

  getEmergencyStop() {
    const row = this.db.prepare(`SELECT value_json FROM system_controls WHERE key = 'emergency_stop'`).get();
    return parseJson(row?.value_json, { active: false, by: null, reason: null, at: null });
  }

  setEmergencyStop(active, by = null, reason = null) {
    const ts = nowIso();
    const value = {
      active: !!active,
      by: by ? String(by).slice(0, 120) : null,
      reason: reason ? String(reason).slice(0, 300) : null,
      at: ts,
    };
    this.db.prepare(`
INSERT INTO system_controls (key, value_json, updated_at)
VALUES ('emergency_stop', ?, ?)
ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
`).run(JSON.stringify(value), ts);
    return value;
  }

  getCircuit() {
    return this.db.prepare(`SELECT * FROM circuit_breakers WHERE scope = 'global'`).get();
  }

  resetCircuit(reason = 'manual_reset') {
    const ts = nowIso();
    this.db.prepare(`
UPDATE circuit_breakers
SET status = 'closed', failure_count = 0, opened_at = NULL, reason = ?, updated_at = ?
WHERE scope = 'global'
`).run(String(reason).slice(0, 300), ts);
    return this.getCircuit();
  }

  _registerCriticalFailure(taskId, reason, ts = nowIso()) {
    const circuit = this.getCircuit();
    if (!circuit) return null;
    if (String(circuit.status).toLowerCase() === 'open') {
      this.db.prepare(`
UPDATE circuit_breakers SET reason = ?, updated_at = ? WHERE scope = 'global'
`).run(String(reason).slice(0, 300), ts);
      return this.getCircuit();
    }
    const currentFailures = Number(circuit.failure_count || 0);
    const threshold = Number(circuit.threshold || this.circuitThreshold);
    const nextFailures = currentFailures + 1;
    if (nextFailures >= threshold) {
      this.db.prepare(`
UPDATE circuit_breakers
SET status = 'open', failure_count = ?, opened_at = ?, reason = ?, updated_at = ?
WHERE scope = 'global'
`).run(nextFailures, ts, String(reason).slice(0, 300), ts);
      this._recordDecision(taskId, 'open_circuit_breaker', reason, { threshold, failures: nextFailures }, ts);
    } else {
      this.db.prepare(`
UPDATE circuit_breakers
SET failure_count = ?, reason = ?, updated_at = ?
WHERE scope = 'global'
`).run(nextFailures, String(reason).slice(0, 300), ts);
    }
    return this.getCircuit();
  }

  _registerCriticalSuccess() {
    const circuit = this.getCircuit();
    if (!circuit) return;
    if (String(circuit.status).toLowerCase() !== 'closed') return;
    if (Number(circuit.failure_count || 0) === 0) return;
    this.db.prepare(`
UPDATE circuit_breakers
SET failure_count = 0, reason = NULL, updated_at = ?
WHERE scope = 'global'
`).run(nowIso());
  }

  createTask(spec = {}, opts = {}) {
    const goal = String(spec.goal || '').trim();
    const repo = String(spec.repo || '').trim();
    const branch = String(spec.branch || '').trim() || 'main';
    if (!goal) throw new Error('goal is required');
    if (!repo) throw new Error('repo is required');

    const ts = nowIso();
    const taskId = randomId('task');
    const acceptanceCriteria = safeArray(spec.acceptance_criteria, 60);
    const priority = normalizePriority(spec.priority);
    const riskProfile = normalizeRiskProfile(spec.risk_profile);
    const parallelismLimit = clampInt(
      spec.parallelism_limit,
      1,
      10,
      clampInt(opts.defaultTaskParallelism, 1, 10, this.defaultTaskParallelism),
    );
    const metadata = {
      rollback_available: spec.rollback_available !== false,
      source: spec.source ? String(spec.source).slice(0, 120) : 'api',
      requested_by: spec.requested_by ? String(spec.requested_by).slice(0, 120) : null,
    };

    this._withTx(() => {
      this.db.prepare(`
INSERT INTO tasks (
  task_id, goal, repo, branch, acceptance_criteria_json, priority, risk_profile,
  status, parallelism_limit, metadata_json, created_at, updated_at, started_at,
  completed_at, failed_reason, degraded
)
VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, NULL, 0)
`).run(
        taskId,
        goal,
        repo,
        branch,
        JSON.stringify(acceptanceCriteria),
        priority,
        riskProfile,
        parallelismLimit,
        JSON.stringify(metadata),
        ts,
        ts,
      );
      this._recordTaskEvent(taskId, 'task.created', {
        goal,
        repo,
        branch,
        priority,
        risk_profile: riskProfile,
        parallelism_limit: parallelismLimit,
      }, ts);
    });

    return this.getTask(taskId);
  }

  listTasks(limit = 40) {
    const safeLimit = clampInt(limit, 1, 200, 40);
    const rows = this.db.prepare(`
SELECT * FROM tasks
ORDER BY created_at DESC
LIMIT ?
`).all(safeLimit);
    return rows.map((row) => this._normalizeTask(row));
  }

  getTask(taskId) {
    const row = this._taskRow(taskId);
    if (!row) return null;
    const task = this._normalizeTask(row);

    const planRow = this.db.prepare(`SELECT plan_json FROM task_plans WHERE task_id = ?`).get(taskId);
    const plan = parseJson(planRow?.plan_json, null);

    const jobsRows = this._jobsForTaskRows(taskId);
    const jobs = jobsRows.map((item) => this._normalizeJob(item));

    const events = this.db.prepare(`
SELECT id, event_type, payload_json, ts
FROM task_events
WHERE task_id = ?
ORDER BY id DESC
LIMIT 400
`).all(taskId).reverse().map((item) => ({
      id: Number(item.id),
      event_type: item.event_type,
      payload: parseJson(item.payload_json, null),
      ts: item.ts,
    }));

    const decisions = this.db.prepare(`
SELECT id, decision, reason, evidence_json, ts
FROM decision_records
WHERE task_id = ?
ORDER BY id DESC
LIMIT 200
`).all(taskId).reverse().map((item) => ({
      id: Number(item.id),
      decision: item.decision,
      reason: item.reason,
      evidence: parseJson(item.evidence_json, null),
      ts: item.ts,
    }));

    const rollbacks = this.db.prepare(`
SELECT id, reason, from_version, to_version, status, ts
FROM rollback_records
WHERE task_id = ?
ORDER BY id DESC
LIMIT 40
`).all(taskId).reverse().map((item) => ({
      id: Number(item.id),
      reason: item.reason,
      from_version: item.from_version,
      to_version: item.to_version,
      status: item.status,
      ts: item.ts,
    }));

    const dagProgress = this._dagProgress(jobs);

    return {
      ...task,
      execution_plan: plan,
      dag_progress: dagProgress,
      sub_tasks: jobs,
      events,
      decisions,
      rollbacks,
      controls: {
        emergency_stop: this.getEmergencyStop(),
        circuit_breaker: this.getCircuit(),
      },
    };
  }

  _dagProgress(jobs) {
    const counters = {
      total: jobs.length,
      blocked: 0,
      queued: 0,
      dispatched: 0,
      running: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
      canceled: 0,
    };
    for (const job of jobs) {
      const status = String(job.status || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(counters, status)) {
        counters[status] += 1;
      }
    }
    return counters;
  }

  listPlanningCandidates(limit = 10) {
    const safeLimit = clampInt(limit, 1, 100, 10);
    const rows = this.db.prepare(`
SELECT * FROM tasks
WHERE status IN ('queued', 'planning')
ORDER BY created_at ASC
LIMIT ?
`).all(safeLimit);
    return rows.map((item) => this._normalizeTask(item));
  }

  attachPlan(taskId, plan, reason = 'initial_plan') {
    if (!plan || !Array.isArray(plan.nodes) || plan.nodes.length === 0) {
      throw new Error('execution plan must include nodes');
    }

    const ts = nowIso();

    this._withTx(() => {
      const task = this._taskRow(taskId);
      if (!task) throw new Error('task_not_found');

      this.db.prepare(`
INSERT INTO task_plans (task_id, plan_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(task_id) DO UPDATE SET plan_json = excluded.plan_json, updated_at = excluded.updated_at
`).run(taskId, JSON.stringify(plan), ts);

      const existingJobsCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE task_id = ?`).get(taskId)?.count || 0);
      if (existingJobsCount === 0) {
        const insert = this.db.prepare(`
INSERT INTO jobs (
  job_id, task_id, node_id, role, payload_json, timeout_s, max_retries,
  attempt, status, worker_id, depends_on_json, next_run_at, last_error,
  artifacts_json, logs_json, metrics_json, created_at, updated_at, started_at, finished_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
`);

        for (const node of plan.nodes) {
          const dependsOn = Array.isArray(node.depends_on) ? node.depends_on : [];
          const status = dependsOn.length > 0 ? 'blocked' : 'queued';
          insert.run(
            randomId('job'),
            taskId,
            String(node.node_id),
            String(node.role),
            JSON.stringify(node.payload || {}),
            clampInt(node.timeout_s, 30, 12 * 3600, 1800),
            clampInt(node.max_retries, 0, 8, 1),
            status,
            JSON.stringify(dependsOn),
            status === 'queued' ? ts : null,
            ts,
            ts,
          );
        }
      }

      const parallelism = clampInt(plan.parallelism_limit, 1, 10, this.defaultTaskParallelism);
      this.db.prepare(`
UPDATE tasks
SET status = 'running', parallelism_limit = ?, updated_at = ?, started_at = COALESCE(started_at, ?)
WHERE task_id = ?
`).run(parallelism, ts, ts, taskId);

      this._recordTaskEvent(taskId, 'task.planned', {
        reason,
        nodes: plan.nodes.map((node) => node.node_id),
        edges: plan.edges || [],
        parallelism_limit: parallelism,
      }, ts);
      this._recordDecision(taskId, 'plan_created', reason, {
        node_count: plan.nodes.length,
        parallelism_limit: parallelism,
      }, ts);
    });

    return this.getTask(taskId);
  }

  unblockReadyJobs(taskId) {
    const now = nowIso();
    return this._withTx(() => {
      const rows = this._jobsForTaskRows(taskId);
      const byNodeStatus = new Map(rows.map((row) => [row.node_id, String(row.status || '').toLowerCase()]));
      let changed = 0;

      const update = this.db.prepare(`
UPDATE jobs
SET status = 'queued', next_run_at = ?, updated_at = ?
WHERE job_id = ? AND status = 'blocked'
`);

      for (const row of rows) {
        if (String(row.status || '').toLowerCase() !== 'blocked') continue;
        const deps = parseJson(row.depends_on_json, []);
        const ready = deps.every((dep) => byNodeStatus.get(dep) === 'completed');
        if (!ready) continue;
        const result = update.run(now, now, row.job_id);
        if (result.changes === 1) {
          changed += 1;
          this._recordTaskEvent(taskId, 'job.unblocked', {
            job_id: row.job_id,
            node_id: row.node_id,
            depends_on: deps,
          }, now);
        }
      }

      if (changed > 0) {
        this._recomputeTaskStatusNoTx(taskId, now);
      }
      return changed;
    });
  }

  _recomputeTaskStatusNoTx(taskId, ts = nowIso()) {
    const taskRow = this._taskRow(taskId);
    if (!taskRow) return null;
    const currentStatus = String(taskRow.status || '').toLowerCase();
    if (TERMINAL_TASK_STATUSES.has(currentStatus) || currentStatus === 'paused') {
      return this._normalizeTask(taskRow);
    }

    const jobs = this._jobsForTaskRows(taskId).map((row) => this._normalizeJob(row));
    if (jobs.length === 0) return this._normalizeTask(taskRow);

    const releaseFailed = jobs.some((job) => job.role === 'release' && (job.status === 'failed' || job.status === 'timeout'));
    if (releaseFailed) {
      this._markTaskRolledBackNoTx(taskId, 'release stage failed', 'auto_release_failure', ts);
      return this._normalizeTask(this._taskRow(taskId));
    }

    const hardFail = jobs.find((job) => job.status === 'failed' || job.status === 'timeout' || job.status === 'canceled');
    if (hardFail) {
      this.db.prepare(`
UPDATE tasks
SET status = 'failed', failed_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
WHERE task_id = ?
`).run(hardFail.last_error || `${hardFail.node_id} ${hardFail.status}`, ts, ts, taskId);
      this._recordTaskEvent(taskId, 'task.failed', {
        reason: hardFail.last_error || null,
        node_id: hardFail.node_id,
        status: hardFail.status,
      }, ts);
      return this._normalizeTask(this._taskRow(taskId));
    }

    const allCompleted = jobs.every((job) => job.status === 'completed');
    if (allCompleted) {
      this.db.prepare(`
UPDATE tasks
SET status = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ?
WHERE task_id = ?
`).run(ts, ts, taskId);
      this._recordTaskEvent(taskId, 'task.done', null, ts);
      return this._normalizeTask(this._taskRow(taskId));
    }

    const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
    let nextStatus = 'running';
    if (activeJobs.some((job) => job.role === 'release')) {
      nextStatus = 'releasing';
    } else if (activeJobs.some((job) => job.role === 'reviewer')) {
      nextStatus = 'reviewing';
    }

    if (nextStatus !== currentStatus) {
      this.db.prepare(`
UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?
`).run(nextStatus, ts, taskId);
      this._recordTaskEvent(taskId, 'task.phase_changed', { status: nextStatus }, ts);
    }
    return this._normalizeTask(this._taskRow(taskId));
  }

  recomputeTaskStatus(taskId) {
    return this._withTx(() => this._recomputeTaskStatusNoTx(taskId, nowIso()));
  }

  _cancelOutstandingJobsNoTx(taskId, reason, ts = nowIso()) {
    const result = this.db.prepare(`
UPDATE jobs
SET status = 'canceled', last_error = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
WHERE task_id = ?
  AND status IN ('blocked', 'queued', 'dispatched', 'claimed', 'running')
`).run(String(reason || 'canceled').slice(0, 500), ts, ts, taskId);
    return Number(result.changes || 0);
  }

  _markTaskRolledBackNoTx(taskId, reason, trigger = 'auto', ts = nowIso()) {
    const row = this._taskRow(taskId);
    if (!row) return;
    const current = String(row.status || '').toLowerCase();
    if (current === 'rolled_back') return;

    this._cancelOutstandingJobsNoTx(taskId, `rolled back: ${reason}`, ts);
    this.db.prepare(`
UPDATE tasks
SET status = 'rolled_back', degraded = 1, failed_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
WHERE task_id = ?
`).run(String(reason || 'rollback').slice(0, 500), ts, ts, taskId);

    this.db.prepare(`
INSERT INTO rollback_records (task_id, reason, from_version, to_version, status, ts)
VALUES (?, ?, NULL, NULL, 'completed', ?)
`).run(taskId, String(reason || 'rollback').slice(0, 500), ts);

    this._recordTaskEvent(taskId, 'task.rolled_back', {
      reason,
      trigger,
    }, ts);
    this._recordDecision(taskId, 'auto_rollback', String(reason || 'rollback'), { trigger }, ts);
  }

  markTaskRolledBack(taskId, reason, trigger = 'manual') {
    return this._withTx(() => {
      this._markTaskRolledBackNoTx(taskId, reason, trigger, nowIso());
      return this._normalizeTask(this._taskRow(taskId));
    });
  }

  controlTask(taskId, action, meta = {}) {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const ts = nowIso();
    const requestedBy = String(meta.requested_by || 'api').slice(0, 120);
    const reason = String(meta.reason || '').slice(0, 300) || null;

    return this._withTx(() => {
      const row = this._taskRow(taskId);
      if (!row) throw new Error('task_not_found');
      const status = String(row.status || '').toLowerCase();

      if (normalizedAction === 'pause') {
        if (!TERMINAL_TASK_STATUSES.has(status) && status !== 'paused') {
          this.db.prepare(`UPDATE tasks SET status = 'paused', updated_at = ? WHERE task_id = ?`).run(ts, taskId);
          this._recordTaskEvent(taskId, 'task.paused', { requested_by: requestedBy, reason }, ts);
        }
      } else if (normalizedAction === 'resume') {
        if (status === 'paused') {
          this.db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ?`).run(ts, taskId);
          this._recordTaskEvent(taskId, 'task.resumed', { requested_by: requestedBy, reason }, ts);
          this._recomputeTaskStatusNoTx(taskId, ts);
        }
      } else if (normalizedAction === 'cancel') {
        if (!TERMINAL_TASK_STATUSES.has(status)) {
          this._cancelOutstandingJobsNoTx(taskId, reason || 'canceled by control API', ts);
          this.db.prepare(`
UPDATE tasks
SET status = 'canceled', failed_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
WHERE task_id = ?
`).run(reason || 'canceled by control API', ts, ts, taskId);
          this._recordTaskEvent(taskId, 'task.canceled', { requested_by: requestedBy, reason }, ts);
        }
      } else if (normalizedAction === 'emergency_stop') {
        this.setEmergencyStop(true, requestedBy, reason || `requested for task ${taskId}`);
        this.db.prepare(`UPDATE tasks SET status = 'paused', updated_at = ? WHERE task_id = ?`).run(ts, taskId);
        this._recordTaskEvent(taskId, 'task.emergency_stop', { requested_by: requestedBy, reason }, ts);
      } else if (normalizedAction === 'force_rollback') {
        this._markTaskRolledBackNoTx(taskId, reason || 'manual force rollback', 'manual_force_rollback', ts);
      } else {
        throw new Error('unsupported_action');
      }

      this._recordDecision(taskId, 'task_control_action', normalizedAction, {
        requested_by: requestedBy,
        reason,
      }, ts);

      return this.getTask(taskId);
    });
  }

  controlGlobal(action, meta = {}) {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const requestedBy = String(meta.requested_by || 'api').slice(0, 120);
    const reason = String(meta.reason || '').slice(0, 300) || null;

    if (normalizedAction === 'emergency_stop_clear') {
      return {
        emergency_stop: this.setEmergencyStop(false, requestedBy, reason || 'manual clear'),
        circuit_breaker: this.getCircuit(),
      };
    }
    if (normalizedAction === 'circuit_reset') {
      return {
        emergency_stop: this.getEmergencyStop(),
        circuit_breaker: this.resetCircuit(reason || `manual reset by ${requestedBy}`),
      };
    }
    throw new Error('unsupported_global_action');
  }

  getDispatchableJobs(limit = 10) {
    const safeLimit = clampInt(limit, 1, 200, this.globalParallelism);
    const emergencyStop = this.getEmergencyStop();
    if (emergencyStop?.active) return [];

    const circuit = this.getCircuit();
    const activeGlobal = this._globalActiveJobsCount();
    const available = Math.max(0, this.globalParallelism - activeGlobal);
    const slots = Math.min(safeLimit, available);
    if (slots <= 0) return [];

    const now = nowIso();
    const candidates = this.db.prepare(`
SELECT j.*, t.parallelism_limit, t.status AS task_status, t.metadata_json
FROM jobs AS j
JOIN tasks AS t ON t.task_id = j.task_id
WHERE j.status = 'queued'
  AND (j.next_run_at IS NULL OR j.next_run_at <= ?)
  AND t.status IN ('running', 'reviewing', 'releasing')
ORDER BY j.created_at ASC
LIMIT ?
`).all(now, slots * 6 + 20);

    if (!candidates.length) return [];

    const taskIds = Array.from(new Set(candidates.map((row) => String(row.task_id))));
    const activeByTask = this._activeJobsCountByTask(taskIds);

    const selected = [];
    for (const row of candidates) {
      if (selected.length >= slots) break;

      const taskId = String(row.task_id);
      const taskActive = activeByTask.get(taskId) || 0;
      const perTaskLimit = clampInt(row.parallelism_limit, 1, 10, this.defaultTaskParallelism);
      if (taskActive >= perTaskLimit) continue;

      const task = {
        metadata: parseJson(row.metadata_json, {}),
      };
      const job = this._normalizeJob(row);
      if (isHighRiskJob(job) && !canDispatchHighRisk(task, circuit, false)) {
        continue;
      }

      selected.push(job);
      activeByTask.set(taskId, taskActive + 1);
    }

    return selected;
  }

  dispatchJobs(jobIds, dispatcherId = 'dispatcher') {
    const ids = Array.isArray(jobIds) ? jobIds.filter(Boolean) : [];
    if (!ids.length) return 0;

    const ts = nowIso();
    return this._withTx(() => {
      const update = this.db.prepare(`
UPDATE jobs
SET status = 'dispatched', updated_at = ?
WHERE job_id = ? AND status = 'queued'
`);

      let changes = 0;
      for (const jobId of ids) {
        const result = update.run(ts, jobId);
        if (result.changes !== 1) continue;
        changes += 1;

        const job = this.db.prepare(`SELECT task_id, node_id FROM jobs WHERE job_id = ?`).get(jobId);
        if (!job) continue;
        this._recordTaskEvent(job.task_id, 'job.dispatched', {
          job_id: jobId,
          node_id: job.node_id,
          dispatcher_id: dispatcherId,
        }, ts);
      }
      return changes;
    });
  }

  claimDispatchedJobs(workerId, limit = 1) {
    const id = String(workerId || '').trim();
    if (!id) throw new Error('worker_id is required');
    const safeLimit = clampInt(limit, 1, 20, 1);

    const emergencyStop = this.getEmergencyStop();
    if (emergencyStop?.active) return [];

    const ts = nowIso();
    return this._withTx(() => {
      const rows = this.db.prepare(`
SELECT * FROM jobs
WHERE status = 'dispatched'
ORDER BY created_at ASC
LIMIT ?
`).all(safeLimit);

      const claimed = [];
      const claimStmt = this.db.prepare(`
UPDATE jobs
SET status = 'running', worker_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
WHERE job_id = ? AND status = 'dispatched'
`);

      for (const row of rows) {
        const result = claimStmt.run(id, ts, ts, row.job_id);
        if (result.changes !== 1) continue;

        claimed.push(this._normalizeJob(this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(row.job_id)));
        this._recordTaskEvent(row.task_id, 'job.running', {
          job_id: row.job_id,
          node_id: row.node_id,
          worker_id: id,
        }, ts);
        this._recomputeTaskStatusNoTx(row.task_id, ts);
      }

      return claimed;
    });
  }

  applyWorkerResult(rawPayload = {}) {
    const jobId = String(rawPayload.job_id || '').trim();
    if (!jobId) throw new Error('job_id is required');

    const workerId = rawPayload.worker_id == null
      ? null
      : String(rawPayload.worker_id || '').trim().slice(0, 120);
    const normalizedStatus = normalizeWorkerResultStatus(rawPayload.status);
    const errorMessage = rawPayload.error == null
      ? null
      : String(rawPayload.error || '').trim().slice(0, 500);
    const artifacts = rawPayload.artifacts == null ? null : rawPayload.artifacts;
    const logs = rawPayload.logs == null ? null : rawPayload.logs;
    const metrics = rawPayload.metrics == null ? null : rawPayload.metrics;

    const ts = nowIso();

    return this._withTx(() => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId);
      if (!row) throw new Error('job_not_found');

      const job = this._normalizeJob(row);
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        return {
          job: this._normalizeJob(row),
          task: this.getTask(job.task_id),
          duplicate: true,
        };
      }

      if (workerId && row.worker_id && row.worker_id !== workerId) {
        throw new Error('job_owned_by_other_worker');
      }

      if (normalizedStatus === 'completed') {
        this.db.prepare(`
UPDATE jobs
SET status = 'completed', worker_id = COALESCE(worker_id, ?),
    artifacts_json = ?, logs_json = ?, metrics_json = ?,
    updated_at = ?, finished_at = COALESCE(finished_at, ?)
WHERE job_id = ?
`).run(
          workerId,
          artifacts == null ? null : JSON.stringify(artifacts),
          logs == null ? null : JSON.stringify(logs),
          metrics == null ? null : JSON.stringify(metrics),
          ts,
          ts,
          jobId,
        );

        this._recordTaskEvent(job.task_id, 'job.completed', {
          job_id: jobId,
          node_id: job.node_id,
          worker_id: workerId,
        }, ts);

        if (isCriticalRole(job.role)) {
          this._registerCriticalSuccess();
        }
      } else {
        const retriable = normalizedStatus === 'failed' || normalizedStatus === 'timeout';
        const nextAttempt = Number(job.attempt || 0) + 1;
        const shouldRetry = retriable && Number(job.attempt || 0) < Number(job.max_retries || 0);

        if (shouldRetry) {
          const nextRunAt = nextRunAtFromAttempt(ts, nextAttempt);
          this.db.prepare(`
UPDATE jobs
SET status = 'queued',
    worker_id = COALESCE(worker_id, ?),
    attempt = ?,
    last_error = ?,
    next_run_at = ?,
    updated_at = ?,
    logs_json = ?,
    metrics_json = ?
WHERE job_id = ?
`).run(
            workerId,
            nextAttempt,
            errorMessage || `${job.node_id} ${normalizedStatus}`,
            nextRunAt,
            ts,
            logs == null ? null : JSON.stringify(logs),
            metrics == null ? null : JSON.stringify(metrics),
            jobId,
          );

          this._recordTaskEvent(job.task_id, 'job.retry_scheduled', {
            job_id: jobId,
            node_id: job.node_id,
            attempt: nextAttempt,
            max_retries: job.max_retries,
            next_run_at: nextRunAt,
            error: errorMessage || null,
            status: normalizedStatus,
          }, ts);
        } else {
          this.db.prepare(`
UPDATE jobs
SET status = ?,
    worker_id = COALESCE(worker_id, ?),
    attempt = ?,
    last_error = ?,
    updated_at = ?,
    finished_at = COALESCE(finished_at, ?),
    logs_json = ?,
    metrics_json = ?
WHERE job_id = ?
`).run(
            normalizedStatus,
            workerId,
            nextAttempt,
            errorMessage || `${job.node_id} ${normalizedStatus}`,
            ts,
            ts,
            logs == null ? null : JSON.stringify(logs),
            metrics == null ? null : JSON.stringify(metrics),
            jobId,
          );

          this._recordTaskEvent(job.task_id, `job.${normalizedStatus}`, {
            job_id: jobId,
            node_id: job.node_id,
            attempt: nextAttempt,
            max_retries: job.max_retries,
            error: errorMessage || null,
          }, ts);

          if (isCriticalRole(job.role)) {
            this._registerCriticalFailure(job.task_id, errorMessage || `${job.node_id} ${normalizedStatus}`, ts);
          }

          if (job.role === 'release' && (normalizedStatus === 'failed' || normalizedStatus === 'timeout')) {
            this._markTaskRolledBackNoTx(job.task_id, errorMessage || 'release stage failed', 'auto_release_failure', ts);
          }
        }
      }

      this._recomputeTaskStatusNoTx(job.task_id, ts);

      const updatedJob = this._normalizeJob(this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId));
      return {
        job: updatedJob,
        task: this.getTask(job.task_id),
        duplicate: false,
      };
    });
  }

  systemSnapshot() {
    return {
      emergency_stop: this.getEmergencyStop(),
      circuit_breaker: this.getCircuit(),
      global_active_jobs: this._globalActiveJobsCount(),
    };
  }
}

module.exports = {
  StateStore,
};
