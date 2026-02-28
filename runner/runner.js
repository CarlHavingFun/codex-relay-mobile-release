#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  ensureDir,
  nowIso,
  readJSON,
  writeJSONAtomic,
  appendNDJSON,
  randomId,
  sleep,
  loadEnvIntoProcess,
  hostname,
} = require('./lib/common');
const { loadTasksFromPlan } = require('./lib/plan');
const { loadRules, detectRisk } = require('./lib/risk');
const {
  loadAuthProfiles,
  loadFailoverState,
  nextProfile,
  profileById,
  isEveryProfileExhausted,
} = require('./lib/failover');

const ROOT = path.resolve(__dirname, '..');
loadEnvIntoProcess(path.join(ROOT, 'config', '.env'));

const CONFIG = {
  relayBaseUrl: (process.env.RELAY_BASE_URL || '').replace(/\/$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  runnerId: process.env.RUNNER_ID || `runner_${hostname()}`,
  workspacePath: process.env.WORKSPACE_PATH || ROOT,
  planFile: process.env.PLAN_FILE || path.join(ROOT, 'PLAN.md'),
  stateDir: process.env.STATE_DIR || path.join(ROOT, 'state'),
  pollSeconds: Math.max(3, Number(process.env.POLL_SECONDS || 10)),
  supervisorEnabled: String(process.env.SUPERVISOR_ENABLED || '1').toLowerCase() !== '0',
  checkWorkspacesScript: process.env.CHECK_WORKSPACES_SCRIPT || path.join(ROOT, 'scripts', 'check-workspaces.mjs'),
  maxTaskRetries: Math.max(1, Math.min(2, Number(process.env.RUNNER_MAX_TASK_RETRIES || 2))),
};

const FILES = {
  runnerState: path.join(CONFIG.stateDir, 'runner_state.json'),
  progress: path.join(CONFIG.stateDir, 'plan_progress.json'),
  events: path.join(CONFIG.stateDir, 'events.ndjson'),
  approvals: path.join(CONFIG.stateDir, 'approvals.json'),
  pendingUpload: path.join(CONFIG.stateDir, 'pending_upload.json'),
  lastMessage: path.join(CONFIG.stateDir, 'last_message.txt'),
  authProfiles: path.join(CONFIG.stateDir, 'auth_profiles.json'),
  authProfileState: path.join(CONFIG.stateDir, 'auth_profile_state.json'),
  lock: path.join(CONFIG.stateDir, 'runner.lock'),
  log: path.join(CONFIG.stateDir, 'runner.log'),
};

let shuttingDown = false;
let currentTask = null;
let authProfiles = [];
let authProfileState = null;
let runnerState = readJSON(FILES.runnerState, {
  runner_id: CONFIG.runnerId,
  online: false,
  workspace: CONFIG.workspacePath,
  current_task: null,
  last_success_at: null,
  last_error: null,
  updated_at: null,
});

function logLine(message) {
  const line = `${nowIso()} [runner] ${message}`;
  fs.appendFileSync(FILES.log, `${line}\n`);
  console.log(line);
}

function initFiles() {
  ensureDir(CONFIG.stateDir);
  if (!fs.existsSync(FILES.events)) fs.writeFileSync(FILES.events, '');
  if (!fs.existsSync(FILES.lastMessage)) fs.writeFileSync(FILES.lastMessage, '');
  if (!fs.existsSync(FILES.progress)) {
    writeJSONAtomic(FILES.progress, { completed: {}, failed: {}, rejected: {} });
  }
  if (!fs.existsSync(FILES.approvals)) writeJSONAtomic(FILES.approvals, []);
  if (!fs.existsSync(FILES.pendingUpload)) writeJSONAtomic(FILES.pendingUpload, []);
  if (!fs.existsSync(FILES.authProfiles)) {
    writeJSONAtomic(FILES.authProfiles, [{
      id: 'primary',
      name: 'Primary',
      codex_home: path.join(os.homedir(), '.codex'),
      workspace_hint: workspaceName(),
      priority: 100,
      enabled: true,
    }]);
  }
  if (!fs.existsSync(FILES.authProfileState)) {
    writeJSONAtomic(FILES.authProfileState, {
      active_profile_id: null,
      last_switch_at: null,
      consecutive_failures: 0,
      last_error: null,
    });
  }
  writeState({
    runner_id: CONFIG.runnerId,
    workspace: CONFIG.workspacePath,
    online: true,
    updated_at: nowIso(),
  });
}

function acquireLock() {
  ensureDir(CONFIG.stateDir);
  if (fs.existsSync(FILES.lock)) {
    const lock = readJSON(FILES.lock, {});
    if (lock.pid) {
      try {
        process.kill(lock.pid, 0);
        const probe = spawnSync('ps', ['-p', String(lock.pid), '-o', 'command='], { encoding: 'utf8' });
        const cmd = (probe.stdout || '').trim();
        if (cmd.includes('/runner/runner.js')) {
          throw new Error(`runner already active with pid=${lock.pid}`);
        }
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  }
  writeJSONAtomic(FILES.lock, { pid: process.pid, started_at: nowIso() });
}

function releaseLock() {
  try {
    if (fs.existsSync(FILES.lock)) fs.unlinkSync(FILES.lock);
  } catch {
    // ignore
  }
}

function workspaceName() {
  return path.basename(CONFIG.workspacePath);
}

function loadAuthContext() {
  authProfiles = loadAuthProfiles(FILES.authProfiles);
  authProfileState = loadFailoverState(FILES.authProfileState);
  if (!authProfileState.active_profile_id || !profileById(authProfiles, authProfileState.active_profile_id)) {
    authProfileState.active_profile_id = authProfiles[0]?.id || null;
    writeJSONAtomic(FILES.authProfileState, authProfileState);
  }
}

function saveAuthState(patch) {
  authProfileState = {
    ...(authProfileState || {}),
    ...patch,
  };
  writeJSONAtomic(FILES.authProfileState, authProfileState);
}

function activeProfile() {
  if (!authProfiles.length) return null;
  const current = profileById(authProfiles, authProfileState?.active_profile_id || '');
  if (current) return current;
  return authProfiles[0];
}

function runWorkspaceSwitchScript(profileId) {
  if (!profileId) return;
  if (!fs.existsSync(CONFIG.checkWorkspacesScript)) return;
  const child = spawnSync('node', [CONFIG.checkWorkspacesScript, '--switch', profileId], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if ((child.status ?? 1) !== 0) {
    logLine(`check-workspaces switch failed profile=${profileId} stderr=${String(child.stderr || '').trim()}`);
  }
}

async function reportFailoverEvent(payload) {
  if (!CONFIG.relayBaseUrl || !CONFIG.supervisorEnabled) return;
  try {
    await httpJson('POST', `${CONFIG.relayBaseUrl}/v2/supervisor/failover/report`, payload);
  } catch (err) {
    emitEvent({
      level: 'warn',
      phase: 'supervisor.failover.report_failed',
      message: String(err.message || err),
      payload,
    });
  }
}

function createP0Approval(task, reason) {
  const p0Text = `[P0] ${task.text}`;
  const ticket = buildApproval({ ...task, text: p0Text, mode: 'GATE' }, [reason]);
  upsertApproval(ticket);
  emitEvent({
    task_id: task.id,
    level: 'error',
    phase: 'approval.created',
    message: `P0 approval required: ${reason}`,
    payload: {
      ticket: {
        ...ticket,
        priority: 'P0',
      },
    },
  });
}

function emitEvent(event) {
  const merged = {
    id: event.id || randomId('evt'),
    runner_id: CONFIG.runnerId,
    workspace: workspaceName(),
    ts: event.ts || nowIso(),
    ...event,
  };
  appendNDJSON(FILES.events, merged);
  const queue = readJSON(FILES.pendingUpload, []);
  queue.push(merged);
  writeJSONAtomic(FILES.pendingUpload, queue.slice(-5000));
}

function writeState(patch) {
  runnerState = {
    ...runnerState,
    ...patch,
    runner_id: CONFIG.runnerId,
    workspace: CONFIG.workspacePath,
    updated_at: nowIso(),
  };
  writeJSONAtomic(FILES.runnerState, runnerState);
}

function getProgress() {
  return readJSON(FILES.progress, { completed: {}, failed: {}, rejected: {} });
}

function setProgress(progress) {
  writeJSONAtomic(FILES.progress, progress);
}

function getApprovals() {
  return readJSON(FILES.approvals, []);
}

function setApprovals(approvals) {
  writeJSONAtomic(FILES.approvals, approvals);
}

function compatibilityFallbackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname.startsWith('/v1/') || parsed.pathname.startsWith('/v2/')) {
    return null;
  }
  if (parsed.pathname === '/legacy-runner' || parsed.pathname.startsWith('/legacy-runner/')) {
    const rest = parsed.pathname.slice('/legacy-runner/'.length);
    parsed.pathname = rest === 'heartbeat' ? '/v1/runner/heartbeat' : `/v1/${rest}`;
    return parsed.toString();
  }
  if (parsed.pathname === '/codex-iphone-connector' || parsed.pathname.startsWith('/codex-iphone-connector/')) {
    const rest = parsed.pathname.slice('/codex-iphone-connector/'.length);
    if (
      rest.startsWith('chat/')
      || rest === 'status'
      || rest === 'workspaces'
      || rest.startsWith('usage/')
      || rest.startsWith('sessions/backfill/')
    ) {
      parsed.pathname = `/v2/${rest}`;
      return parsed.toString();
    }
    if (
      rest === 'register'
      || rest === 'heartbeat'
      || rest.startsWith('sessions/')
      || rest.startsWith('auth/')
      || rest.startsWith('jobs/')
    ) {
      parsed.pathname = `/v2/connector/${rest}`;
      return parsed.toString();
    }
    parsed.pathname = `/v2/${rest}`;
    return parsed.toString();
  }
  return null;
}

function isRelayNotFoundPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.ok !== false) return false;
  return String(payload.error || '').trim().toLowerCase() === 'not_found';
}

async function httpJson(method, url, body, allowCompatRetry = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.relayToken) headers.Authorization = `Bearer ${CONFIG.relayToken}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const fallbackUrl = allowCompatRetry ? compatibilityFallbackUrl(url) : null;
    if (res.status === 404 && fallbackUrl) {
      return httpJson(method, fallbackUrl, body, false);
    }
    throw new Error(`${method} ${url} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  const fallbackUrl = allowCompatRetry ? compatibilityFallbackUrl(url) : null;
  if (fallbackUrl && isRelayNotFoundPayload(json)) {
    return httpJson(method, fallbackUrl, body, false);
  }
  if (json && typeof json === 'object' && json.ok === false && json.error) {
    throw new Error(`${method} ${url} failed: ${String(json.error)}`);
  }
  return json;
}

async function flushPendingEvents() {
  if (!CONFIG.relayBaseUrl) return;
  const queue = readJSON(FILES.pendingUpload, []);
  if (!queue.length) return;
  const batch = queue.slice(0, 200);
  await httpJson('POST', `${CONFIG.relayBaseUrl}/legacy-runner/events`, {
    runner_id: CONFIG.runnerId,
    workspace: workspaceName(),
    events: batch,
  });
  writeJSONAtomic(FILES.pendingUpload, queue.slice(batch.length));
}

async function sendHeartbeat() {
  if (!CONFIG.relayBaseUrl) return;
  await httpJson('POST', `${CONFIG.relayBaseUrl}/legacy-runner/heartbeat`, {
    runner_id: CONFIG.runnerId,
    workspace: workspaceName(),
    online: !shuttingDown,
    current_task: currentTask,
    last_success_at: runnerState.last_success_at || null,
    last_error: runnerState.last_error || null,
    updated_at: nowIso(),
  });
}

async function syncApprovalDecisionsFromRelay() {
  if (!CONFIG.relayBaseUrl) return;
  const json = await httpJson('GET', `${CONFIG.relayBaseUrl}/legacy-runner/approvals?workspace=${encodeURIComponent(workspaceName())}&state=all`, null);
  const remote = Array.isArray(json.approvals) ? json.approvals : [];
  if (!remote.length) return;
  const local = getApprovals();
  const byId = new Map(local.map((x) => [x.id, x]));
  let changed = false;
  for (const item of remote) {
    if (!item.id) continue;
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      changed = true;
      continue;
    }
    if (prev.state !== item.state || prev.decision_at !== item.decision_at || prev.decision_by !== item.decision_by) {
      byId.set(item.id, { ...prev, ...item });
      changed = true;
    }
  }
  if (changed) setApprovals([...byId.values()]);
}

function normalizeSupervisorTask(task) {
  const modeRaw = String(task.approval_mode || task.mode || 'AUTO').toUpperCase();
  const mode = modeRaw === 'GATE' ? 'GATE' : 'AUTO';
  const title = String(task.title || 'Supervisor Task').trim();
  const objective = String(task.objective || '').trim();
  const text = objective ? `${title}: ${objective}` : title;
  return {
    id: String(task.id || randomId('sup_task')),
    lineNo: 0,
    mode,
    text,
    fingerprint: `supervisor:${String(task.id || randomId('sup'))}`,
    raw: text,
    source: 'supervisor',
    supervisor: task,
  };
}

async function claimSupervisorTask() {
  if (!CONFIG.relayBaseUrl || !CONFIG.supervisorEnabled) return null;
  const profile = activeProfile();
  const body = {
    workspace: workspaceName(),
    runner_id: CONFIG.runnerId,
    profile_id: profile?.id || null,
  };
  const json = await httpJson('POST', `${CONFIG.relayBaseUrl}/v2/supervisor/tasks/claim`, body);
  if (!json?.task) return null;
  return normalizeSupervisorTask(json.task);
}

async function updateSupervisorTask(task, status, extra = {}) {
  if (!CONFIG.relayBaseUrl || task?.source !== 'supervisor') return;
  const taskId = task.supervisor?.id || task.id;
  if (!taskId) return;
  await httpJson('POST', `${CONFIG.relayBaseUrl}/v2/supervisor/tasks/${encodeURIComponent(taskId)}/update`, {
    status,
    runner_id: CONFIG.runnerId,
    workspace: workspaceName(),
    ...extra,
  });
}

function buildApproval(task, reasonList) {
  return {
    id: randomId('apr'),
    task_id: task.id,
    workspace: workspaceName(),
    mode: 'GATE',
    task_text: task.text,
    risk_reason: reasonList,
    state: 'pending',
    decision_by: null,
    decision_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function findApprovalForTask(taskId) {
  const approvals = getApprovals();
  return approvals.find((x) => x.task_id === taskId) || null;
}

function upsertApproval(ticket) {
  const approvals = getApprovals();
  const idx = approvals.findIndex((x) => x.id === ticket.id);
  if (idx >= 0) approvals[idx] = ticket;
  else approvals.push(ticket);
  setApprovals(approvals);
}

async function selectTask() {
  const supervisorTask = await claimSupervisorTask().catch((err) => {
    emitEvent({
      level: 'warn',
      phase: 'supervisor.claim_failed',
      message: String(err.message || err),
    });
    return null;
  });
  if (supervisorTask) return supervisorTask;
  const tasks = loadTasksFromPlan(CONFIG.planFile);
  const progress = getProgress();
  for (const task of tasks) {
    if (progress.completed[task.fingerprint]) continue;
    if (progress.rejected[task.fingerprint]) continue;
    return task;
  }
  return null;
}

async function executeCodexTask(task, profile) {
  const supervisorPrompt = task?.supervisor?.dispatch?.prompt || task?.supervisor?.prompt || '';
  const taskDescriptor = task.source === 'supervisor' ? 'Task from Supervisor' : 'Task from PLAN.md';
  const prompt = String(supervisorPrompt || [
    `Workspace: ${CONFIG.workspacePath}`,
    `${taskDescriptor}: ${task.text}`,
    'Requirements:',
    '- Implement the task end-to-end with validation.',
    '- If blocked, output clear blocker reason.',
    '- Keep changes scoped to this task.',
  ].join('\n'));

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    CONFIG.workspacePath,
    '--full-auto',
    '-o',
    FILES.lastMessage,
    prompt,
  ];

  emitEvent({ task_id: task.id, level: 'info', phase: 'task.start', message: task.text });
  writeState({ current_task: { id: task.id, mode: task.mode, text: task.text, status: 'running' }, last_error: null });
  currentTask = { id: task.id, mode: task.mode, text: task.text, status: 'running' };

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CODEX_HOME: profile?.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    };
    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], env });

    const onLine = (line, source) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        payload = { raw: trimmed };
      }
      emitEvent({
        task_id: task.id,
        level: 'debug',
        phase: `codex.${source}`,
        message: trimmed.slice(0, 800),
        payload,
      });
    };

    let outBuf = '';
    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      const parts = outBuf.split(/\r?\n/);
      outBuf = parts.pop() || '';
      for (const line of parts) onLine(line, 'stdout');
    });

    let errBuf = '';
    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
      const parts = errBuf.split(/\r?\n/);
      errBuf = parts.pop() || '';
      for (const line of parts) onLine(line, 'stderr');
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 1 });
    });
  });
}

async function runTaskWithFailover(task) {
  const attemptedProfiles = [];
  let profile = activeProfile();
  if (!profile) {
    loadAuthContext();
    profile = activeProfile();
  }
  if (!profile) {
    return {
      code: 1,
      reason: 'no auth profile available',
      attemptedProfiles,
    };
  }

  let lastResult = { code: 1 };
  for (let attempt = 0; attempt < CONFIG.maxTaskRetries; attempt += 1) {
    attemptedProfiles.push(profile.id);
    emitEvent({
      task_id: task.id,
      level: 'info',
      phase: 'auth.profile',
      message: `attempt=${attempt + 1} profile=${profile.id}`,
      payload: { profile },
    });
    lastResult = await executeCodexTask(task, profile);
    if (lastResult.code === 0) {
      saveAuthState({
        active_profile_id: profile.id,
        consecutive_failures: 0,
        last_error: null,
      });
      return { ...lastResult, profileId: profile.id, attemptedProfiles };
    }

    const reason = `codex exit code=${lastResult.code}`;
    const next = nextProfile(authProfiles, profile.id);
    if (!next || next.id === profile.id) {
      saveAuthState({
        active_profile_id: profile.id,
        consecutive_failures: (authProfileState?.consecutive_failures || 0) + 1,
        last_error: reason,
      });
      break;
    }

    const fromProfile = profile.id;
    profile = next;
    saveAuthState({
      active_profile_id: profile.id,
      last_switch_at: nowIso(),
      consecutive_failures: (authProfileState?.consecutive_failures || 0) + 1,
      last_error: reason,
    });
    runWorkspaceSwitchScript(profile.id);
    await reportFailoverEvent({
      workspace: workspaceName(),
      runner_id: CONFIG.runnerId,
      from_profile_id: fromProfile,
      to_profile_id: profile.id,
      reason,
      status: 'switched',
      attempted_profiles: attemptedProfiles,
      ts: nowIso(),
    });
  }

  if (isEveryProfileExhausted(authProfiles, attemptedProfiles)) {
    createP0Approval(task, `All auth profiles failed for task ${task.id}`);
  }
  return {
    ...lastResult,
    attemptedProfiles,
    reason: `codex exit code=${lastResult.code}`,
  };
}

function markTaskCompleted(task) {
  const progress = getProgress();
  progress.completed[task.fingerprint] = {
    task_id: task.id,
    completed_at: nowIso(),
    text: task.text,
  };
  setProgress(progress);
}

function markTaskFailed(task, reason) {
  const progress = getProgress();
  progress.failed[task.fingerprint] = {
    task_id: task.id,
    failed_at: nowIso(),
    text: task.text,
    reason,
  };
  setProgress(progress);
}

function markTaskRejected(task, by) {
  const progress = getProgress();
  progress.rejected[task.fingerprint] = {
    task_id: task.id,
    rejected_at: nowIso(),
    text: task.text,
    by: by || 'unknown',
  };
  setProgress(progress);
}

async function processOnce(rules) {
  await syncApprovalDecisionsFromRelay().catch((err) => {
    emitEvent({ level: 'warn', phase: 'relay.sync_approvals.failed', message: String(err.message || err) });
  });

  const task = await selectTask();
  if (!task) {
    writeState({ current_task: null });
    currentTask = null;
    emitEvent({ level: 'info', phase: 'runner.idle', message: 'No pending PLAN.md task found' });
    return;
  }

  const reasons = detectRisk(task.text, rules);
  const effectiveGate = task.mode === 'GATE' || reasons.length > 0;

  if (effectiveGate) {
    let approval = findApprovalForTask(task.id);
    if (!approval) {
      const reasonList = task.mode === 'GATE' ? ['Task mode marked as GATE'] : reasons;
      approval = buildApproval(task, reasonList);
      upsertApproval(approval);
      emitEvent({
        task_id: task.id,
        level: 'warn',
        phase: 'approval.created',
        message: `Approval required for task: ${task.text}`,
        payload: { ticket: approval },
      });
    }

    if (approval.state === 'pending') {
      await updateSupervisorTask(task, 'waiting_approval', {
        reason: 'approval_pending',
        approval_id: approval.id,
      }).catch((err) => {
        emitEvent({
          task_id: task.id,
          level: 'warn',
          phase: 'supervisor.update_failed',
          message: String(err.message || err),
        });
      });
      currentTask = { id: task.id, mode: 'GATE', text: task.text, status: 'waiting_approval', approval_id: approval.id };
      writeState({ current_task: currentTask });
      emitEvent({
        task_id: task.id,
        level: 'info',
        phase: 'task.waiting_approval',
        message: `Waiting approval ticket ${approval.id}`,
      });
      return;
    }

    if (approval.state === 'rejected') {
      if (task.source === 'supervisor') {
        await updateSupervisorTask(task, 'rejected', {
          reason: `rejected by ${approval.decision_by || 'unknown'}`,
          decided_by: approval.decision_by || null,
        }).catch(() => {});
      } else {
        markTaskRejected(task, approval.decision_by);
      }
      emitEvent({
        task_id: task.id,
        level: 'warn',
        phase: 'task.rejected',
        message: `Task rejected by ${approval.decision_by || 'unknown'}`,
      });
      writeState({ current_task: null });
      currentTask = null;
      return;
    }
  }

  await updateSupervisorTask(task, 'running', {
    profile_id: activeProfile()?.id || null,
  }).catch(() => {});

  const result = await runTaskWithFailover(task);
  if (result.code === 0) {
    if (task.source === 'supervisor') {
      await updateSupervisorTask(task, 'completed', {
        profile_id: result.profileId || activeProfile()?.id || null,
        attempted_profiles: result.attemptedProfiles || [],
        result: {
          output_file: FILES.lastMessage,
          completed_at: nowIso(),
        },
      }).catch((err) => {
        emitEvent({
          task_id: task.id,
          level: 'warn',
          phase: 'supervisor.update_failed',
          message: String(err.message || err),
        });
      });
    } else {
      markTaskCompleted(task);
    }
    const finished = nowIso();
    writeState({ current_task: null, last_success_at: finished, last_error: null });
    currentTask = null;
    emitEvent({ task_id: task.id, level: 'info', phase: 'task.completed', message: task.text });
    emitEvent({
      task_id: task.id,
      level: 'info',
      phase: 'task.state',
      message: 'completed',
      payload: { task_id: task.id, task_text: task.text, task_mode: task.mode, status: 'completed', updated_at: finished },
    });
  } else {
    const reason = result.reason || `codex exit code=${result.code}`;
    if (task.source === 'supervisor') {
      await updateSupervisorTask(task, 'failed', {
        reason,
        attempted_profiles: result.attemptedProfiles || [],
        profile_id: activeProfile()?.id || null,
      }).catch((err) => {
        emitEvent({
          task_id: task.id,
          level: 'warn',
          phase: 'supervisor.update_failed',
          message: String(err.message || err),
        });
      });
    } else {
      markTaskFailed(task, reason);
    }
    writeState({ current_task: null, last_error: reason });
    currentTask = null;
    emitEvent({ task_id: task.id, level: 'error', phase: 'task.failed', message: reason });
    emitEvent({
      task_id: task.id,
      level: 'warn',
      phase: 'task.state',
      message: 'failed',
      payload: { task_id: task.id, task_text: task.text, task_mode: task.mode, status: 'failed', updated_at: nowIso() },
    });
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  writeState({ online: false, current_task: null });
  emitEvent({ level: 'info', phase: 'runner.shutdown', message: 'Runner shutting down' });
  await flushPendingEvents().catch(() => {});
  await sendHeartbeat().catch(() => {});
  releaseLock();
}

async function main() {
  acquireLock();
  initFiles();
  loadAuthContext();
  emitEvent({ level: 'info', phase: 'runner.start', message: `Runner ${CONFIG.runnerId} started` });
  logLine(
    `started runner_id=${CONFIG.runnerId} workspace=${CONFIG.workspacePath} ` +
    `supervisor=${CONFIG.supervisorEnabled} active_profile=${activeProfile()?.id || 'n/a'}`,
  );

  const rules = loadRules(ROOT);

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  while (!shuttingDown) {
    try {
      loadAuthContext();
      await processOnce(rules);
      await flushPendingEvents();
      await sendHeartbeat();
    } catch (err) {
      const message = String(err.message || err);
      writeState({ last_error: message });
      emitEvent({ level: 'error', phase: 'runner.loop_error', message });
      logLine(`loop_error=${message}`);
    }
    await sleep(CONFIG.pollSeconds * 1000);
  }
}

main().catch(async (err) => {
  const message = String(err.message || err);
  emitEvent({ level: 'error', phase: 'runner.fatal', message });
  logLine(`fatal=${message}`);
  await shutdown();
  process.exit(1);
});
