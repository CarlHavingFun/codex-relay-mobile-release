#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  ensureDir,
  nowIso,
  sleep,
  randomId,
  loadEnvIntoProcess,
  hostname,
} = require('./lib/common');
const { AppServerClient } = require('./lib/app_server_client');
const {
  isSessionNotLoadedCode,
  isSessionNotLoadedText,
  isRecoverableResumeError,
} = require('./lib/session_errors');
const { relayCompletionForTurnStatus } = require('./lib/turn_completion');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_ENV_FILE = process.env.CONFIG_ENV_FILE || path.join(ROOT, 'config', '.env');
loadEnvIntoProcess(CONFIG_ENV_FILE);

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const norm = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(norm)) return false;
  return fallback;
}

function nonEmptyString(value, fallback = '') {
  const s = String(value || '').trim();
  return s || fallback;
}

function parseTurnTimeoutMs(value, fallbackMs = 900_000) {
  if (value == null || String(value).trim() === '') return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackMs;
  if (parsed <= 0) return 0;
  return Math.max(10_000, Math.floor(parsed));
}

const CONFIG = {
  relayBaseUrl: (process.env.RELAY_BASE_URL || '').replace(/\/$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  connectorId: process.env.CONNECTOR_ID || process.env.RUNNER_ID || `connector_${hostname()}`,
  connectorVersion: process.env.CONNECTOR_VERSION || '0.1.1',
  workspace: nonEmptyString(process.env.CONNECTOR_WORKSPACE || (process.env.WORKSPACE_PATH ? path.basename(process.env.WORKSPACE_PATH) : 'default'), 'default'),
  multiWorkspace: parseBool(process.env.CONNECTOR_MULTI_WORKSPACE, true),
  pollSeconds: Math.max(1, Number(process.env.CONNECTOR_POLL_SECONDS || 2)),
  heartbeatSeconds: Math.max(5, Number(process.env.CONNECTOR_HEARTBEAT_SECONDS || 12)),
  sessionSyncSeconds: Math.max(10, Number(process.env.CONNECTOR_SESSION_SYNC_SECONDS || 45)),
  sessionSyncLimit: Math.max(
    20,
    Math.min(500, Number(process.env.CONNECTOR_SESSION_SYNC_LIMIT || 500)),
  ),
  sessionSyncMetadataLimit: Math.max(
    20,
    Math.min(1200, Number(process.env.CONNECTOR_SESSION_SYNC_METADATA_LIMIT || 120)),
  ),
  sessionSyncFullScanLimit: Math.max(
    100,
    Number(process.env.CONNECTOR_SESSION_SYNC_FULL_SCAN_LIMIT || 2000),
  ),
  sessionSyncMessagesPerThread: Math.max(0, Number(process.env.CONNECTOR_SESSION_SYNC_MESSAGES_PER_THREAD || 12)),
  sessionSyncRequestedThreadMessages: Math.max(0, Number(process.env.CONNECTOR_SESSION_SYNC_REQUESTED_THREAD_MESSAGES || 12)),
  sessionSyncIncludeArchived: parseBool(process.env.CONNECTOR_SESSION_SYNC_INCLUDE_ARCHIVED, true),
  sessionSyncPruneMissing: parseBool(process.env.CONNECTOR_SESSION_SYNC_PRUNE_MISSING, true),
  authReloginTimeoutMs: Math.max(60_000, Number(process.env.CONNECTOR_AUTH_RELOGIN_TIMEOUT_MS || 1_200_000)),
  authReloginLogoutFirst: parseBool(process.env.CONNECTOR_AUTH_RELOGIN_LOGOUT_FIRST, false),
  jobControlPollMs: Math.max(500, Number(process.env.CONNECTOR_JOB_CONTROL_POLL_MS || 1200)),
  turnTimeoutMs: parseTurnTimeoutMs(process.env.CONNECTOR_TURN_TIMEOUT_MS, 900_000),
  requestTimeoutMs: Math.max(5_000, Number(process.env.CONNECTOR_REQUEST_TIMEOUT_MS || 120_000)),
  maxConcurrentJobs: Math.max(1, Math.min(8, Number(process.env.CONNECTOR_MAX_CONCURRENT_JOBS || 1))),
  codexBin: process.env.CODEX_BIN || 'codex',
  stateDir: process.env.STATE_DIR || path.join(ROOT, 'state'),
};

const FILES = {
  log: path.join(CONFIG.stateDir, 'chat_connector.log'),
  state: path.join(CONFIG.stateDir, 'chat_connector_state.json'),
};

let shuttingDown = false;
let appClient = null;
let authHealth = {
  ok: false,
  code: 'CODEx_AUTH_UNAVAILABLE',
  message: 'not checked',
};
let heartbeatTimer = null;
let lastSessionSyncAtMs = 0;
const knownSessionThreadIds = new Set();
const knownSessionUpdatedAtByThreadId = new Map();
const activeJobsById = new Map();
const inFlightJobRuns = new Set();

function logLine(message) {
  const line = `${nowIso()} [chat-connector] ${message}`;
  ensureDir(CONFIG.stateDir);
  fs.appendFileSync(FILES.log, `${line}\n`);
  console.log(line);
}

function writeState(patch) {
  ensureDir(CONFIG.stateDir);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(FILES.state, 'utf8'));
  } catch {
    current = {};
  }
  const merged = {
    ...current,
    connector_id: CONFIG.connectorId,
    workspace: CONFIG.multiWorkspace ? '*' : CONFIG.workspace,
    updated_at: nowIso(),
    ...patch,
  };
  const tmp = `${FILES.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, FILES.state);
}

function activeJobsSnapshot() {
  return Array.from(activeJobsById.entries()).map(([jobId, threadId]) => ({
    job_id: jobId,
    thread_id: threadId,
  }));
}

function writeRuntimeState(statusOverride = null) {
  const activeJobs = activeJobsSnapshot();
  const primary = activeJobs[0] || null;
  const status = statusOverride || (activeJobs.length > 0 ? 'running' : (authHealth.ok ? 'online' : 'degraded'));
  writeState({
    current_job_id: primary ? primary.job_id : null,
    current_thread_id: primary ? primary.thread_id : null,
    active_jobs: activeJobs,
    max_concurrent_jobs: CONFIG.maxConcurrentJobs,
    current_status: status,
    auth_ok: authHealth.ok,
    auth_code: authHealth.code,
    auth_message: authHealth.message,
  });
}

function normalizeUnixSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function loadKnownSessionSyncState() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.state, 'utf8'));
    if (Array.isArray(raw.synced_session_thread_ids)) {
      for (const id of raw.synced_session_thread_ids) {
        if (typeof id === 'string' && id) knownSessionThreadIds.add(id);
      }
    }
    const updatedAtMap = raw.synced_session_updated_at_by_thread_id;
    if (updatedAtMap && typeof updatedAtMap === 'object') {
      for (const [threadId, updatedAt] of Object.entries(updatedAtMap)) {
        if (!threadId) continue;
        const normalized = normalizeUnixSeconds(updatedAt);
        if (normalized == null) continue;
        knownSessionUpdatedAtByThreadId.set(threadId, normalized);
      }
    }
  } catch {
    // ignore
  }
}

function compatibilityFallbackEndpoint(endpoint) {
  const value = String(endpoint || '');
  if (!value.startsWith('/')) return null;
  if (value.startsWith('/v1/') || value.startsWith('/v2/')) return null;
  if (value === '/legacy-runner' || value.startsWith('/legacy-runner/')) {
    const rest = value.slice('/legacy-runner/'.length);
    if (rest === 'heartbeat') return '/v1/runner/heartbeat';
    return `/v1/${rest}`;
  }
  if (value === '/codex-iphone-connector' || value.startsWith('/codex-iphone-connector/')) {
    const rest = value.slice('/codex-iphone-connector/'.length);
    if (
      rest.startsWith('chat/')
      || rest === 'status'
      || rest.startsWith('status?')
      || rest === 'workspaces'
      || rest.startsWith('usage/')
      || rest.startsWith('sessions/backfill/')
    ) {
      return `/v2/${rest}`;
    }
    if (
      rest === 'register'
      || rest === 'heartbeat'
      || rest.startsWith('sessions/')
      || rest.startsWith('auth/')
      || rest.startsWith('jobs/')
    ) {
      return `/v2/connector/${rest}`;
    }
    return `/v2/${rest}`;
  }
  return null;
}

function isRelayNotFoundPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.ok !== false) return false;
  return String(data.error || '').trim().toLowerCase() === 'not_found';
}

async function relayJson(method, endpoint, body = null, allowCompatRetry = true) {
  if (!CONFIG.relayBaseUrl) throw new Error('RELAY_BASE_URL is required');
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.relayToken) headers.Authorization = `Bearer ${CONFIG.relayToken}`;
  const res = await fetch(`${CONFIG.relayBaseUrl}${endpoint}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const fallback = allowCompatRetry ? compatibilityFallbackEndpoint(endpoint) : null;
    if (res.status === 404 && fallback) {
      return relayJson(method, fallback, body, false);
    }
    throw new Error(`${method} ${endpoint} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  const fallback = allowCompatRetry ? compatibilityFallbackEndpoint(endpoint) : null;
  if (fallback && isRelayNotFoundPayload(data)) {
    return relayJson(method, fallback, body, false);
  }
  if (data && typeof data === 'object' && data.ok === false && data.error) {
    throw new Error(`${method} ${endpoint} failed: ${String(data.error)}`);
  }
  return data;
}

function isAuthFailureMessage(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('deactivated_workspace') ||
    m.includes('payment required') ||
    m.includes('unauthorized') ||
    m.includes('401')
  );
}

function mapErrorCode(err) {
  const message = String(err?.message || err || '');
  if (isAuthFailureMessage(message)) return 'CODEx_AUTH_UNAVAILABLE';
  if (isSessionNotLoadedCode(err?.code) || isSessionNotLoadedText(message)) return 'SESSION_NOT_LOADED';
  return 'JOB_EXECUTION_FAILED';
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function parseDeviceAuthHints(text) {
  const clean = stripAnsi(text);
  const urlMatch = clean.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s]*/i)
    || clean.match(/https?:\/\/[^\s]+/i);
  const codeMatch = clean.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/);
  const minutesMatch = clean.match(/expires in\s+(\d+)\s+minutes?/i);
  const minutes = minutesMatch ? Number(minutesMatch[1]) : null;
  let expiresAt = null;
  if (Number.isFinite(minutes) && minutes > 0) {
    expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  }
  return {
    authUrl: urlMatch ? urlMatch[0] : null,
    userCode: codeMatch ? codeMatch[0] : null,
    expiresAt,
  };
}

function extractThreadId(result) {
  return result?.thread?.id || result?.thread_id || result?.id || null;
}

function extractTurnId(result) {
  return result?.turn?.id || result?.turn_id || null;
}

function methodToType(method) {
  return `rpc.${String(method || '').replace(/\//g, '.')}`;
}

function normalizeMethod(method) {
  return String(method || '').replace(/\./g, '/').toLowerCase();
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

const SESSION_SYNC_DATA_IMAGE_URL_MAX_LENGTH = Math.max(
  200_000,
  Number.parseInt(process.env.CONNECTOR_SESSION_SYNC_DATA_IMAGE_URL_MAX_LENGTH || '12000000', 10) || 12_000_000,
);
const SESSION_SYNC_LOCAL_IMAGE_MAX_BYTES = Math.max(
  64 * 1024,
  Number.parseInt(process.env.CONNECTOR_SESSION_SYNC_LOCAL_IMAGE_MAX_BYTES || '8000000', 10) || 8_000_000,
);

function imageMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return 'image/png';
}

function inlineDataUrlFromLocalImagePath(imagePath) {
  const candidate = String(imagePath || '').trim();
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return null;
    if (stat.size <= 0 || stat.size > SESSION_SYNC_LOCAL_IMAGE_MAX_BYTES) return null;
    const mime = imageMimeTypeFromPath(candidate);
    const encoded = fs.readFileSync(candidate).toString('base64');
    if (!encoded) return null;
    const dataUrl = `data:${mime};base64,${encoded}`;
    if (dataUrl.length > SESSION_SYNC_DATA_IMAGE_URL_MAX_LENGTH) return null;
    return dataUrl;
  } catch {
    return null;
  }
}

function isInlineDataImageUrl(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text.startsWith('data:image') && text.includes(';base64,');
}

function isLikelyEncodedBlobText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (isInlineDataImageUrl(text)) return true;

  const compact = text.replace(/\s+/g, '');
  if (compact.length < 160) return false;
  const base64CharCount = (compact.match(/[A-Za-z0-9+/=]/g) || []).length;
  const base64Ratio = base64CharCount / compact.length;
  if (base64Ratio < 0.97) return false;
  if (compact.includes('://')) return false;

  const hasImageSignature = (
    compact.startsWith('/9j/') ||
    compact.startsWith('iVBOR') ||
    compact.startsWith('R0lGOD') ||
    compact.startsWith('UklGR')
  );
  const hasPadding = compact.includes('=');
  const slashPlusCount = (compact.match(/[+/]/g) || []).length;
  if (!(hasImageSignature || hasPadding || slashPlusCount >= 8)) return false;
  return true;
}

function normalizeImageUrlValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.url,
    value.href,
    value.value,
    value.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function normalizeSessionSyncMessageContent(content) {
  if (typeof content === 'string') {
    const textValue = content.trim();
    const text = isLikelyEncodedBlobText(textValue) ? '' : textValue;
    return { text, inputItems: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', inputItems: [] };
  }

  const textParts = [];
  const inputItems = [];
  let imageCount = 0;

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const itemType = String(item.type || '').trim().toLowerCase();
    const itemText = typeof item.text === 'string' ? item.text.trim() : '';
    const imageUrl = [
      item.image_url,
      item.imageUrl,
      item.url,
    ]
      .map(normalizeImageUrlValue)
      .find((value) => typeof value === 'string' && value.length > 0) || null;

    const imagePath = [
      item.path,
      item.file_path,
      item.filePath,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);

    const shouldTreatAsImage = (
      itemType === 'input_image' ||
      itemType === 'image' ||
      itemType === 'localimage' ||
      itemType === 'local_image' ||
      !!imageUrl ||
      !!imagePath ||
      isInlineDataImageUrl(itemText)
    );

    if (shouldTreatAsImage) {
      if (imageUrl) {
        if (imageUrl.length <= SESSION_SYNC_DATA_IMAGE_URL_MAX_LENGTH) {
          inputItems.push({ type: 'image', url: imageUrl });
          imageCount += 1;
        }
      } else if (imagePath) {
        const inlined = inlineDataUrlFromLocalImagePath(imagePath);
        if (inlined) {
          inputItems.push({ type: 'image', url: inlined });
        } else {
          inputItems.push({ type: 'localImage', path: imagePath });
        }
        imageCount += 1;
      }
      continue;
    }

    if (itemText && !isLikelyEncodedBlobText(itemText)) {
      textParts.push(itemText);
    }
  }

  let text = textParts.join('\n').trim();
  if (!text && imageCount > 0) {
    text = imageCount > 1 ? `[${imageCount} images]` : '[Image]';
  }
  return { text, inputItems };
}

function toIsoFromUnixSeconds(value, fallback = nowIso()) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return new Date(num * 1000).toISOString();
}

function inferWorkspaceFromCwd(cwd) {
  if (typeof cwd === 'string' && cwd.trim()) {
    const base = path.basename(cwd.trim());
    if (base) return base;
  }
  if (!CONFIG.multiWorkspace) return CONFIG.workspace;
  return '__unknown__';
}

const REASONING_EFFORT_SET = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SUMMARY_SET = new Set(['auto', 'concise', 'detailed', 'none']);
const MODEL_ALIASES = new Map([
  ['gpt-5.3', 'gpt-5.3-codex'],
  ['gpt5.3', 'gpt-5.3-codex'],
  ['gpt-5.3-codex', 'gpt-5.3-codex'],
]);

function normalizeModelName(value) {
  const model = nonEmptyString(value);
  if (!model) return null;
  return MODEL_ALIASES.get(model.toLowerCase()) || model;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort || !REASONING_EFFORT_SET.has(effort)) return null;
  return effort;
}

function normalizeReasoningSummary(value) {
  const summary = String(value || '').trim().toLowerCase();
  if (!summary || !REASONING_SUMMARY_SET.has(summary)) return null;
  return summary;
}

function normalizeSandboxPolicy(value) {
  if (!value) return null;
  if (typeof value === 'object' && typeof value.type === 'string') return value;
  const mode = String(value).trim().toLowerCase();
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'workspace-write') return { type: 'workspaceWrite' };
  if (mode === 'read-only') return { type: 'readOnly' };
  return null;
}

function normalizeCollaborationMode(policy) {
  const explicit = policy?.collaborationMode;
  const toMode = (raw) => {
    const mode = String(raw || '').trim().toLowerCase();
    if (mode === 'plan' || mode === 'default') return mode;
    return null;
  };

  if (explicit && typeof explicit === 'object') {
    const mode = toMode(explicit.mode);
    const settings = explicit.settings && typeof explicit.settings === 'object' ? explicit.settings : {};
    const model = normalizeModelName(settings.model);
    if (mode && model) {
      return {
        mode,
        settings: {
          model,
          reasoning_effort: normalizeReasoningEffort(
            settings.reasoning_effort ?? settings.reasoningEffort,
          ),
          developer_instructions:
            settings.developer_instructions == null
              ? null
              : String(settings.developer_instructions),
        },
      };
    }
  }

  const mode = toMode(policy?.mode);
  const model = normalizeModelName(policy?.model);
  if (!mode || !model) return null;
  return {
    mode,
    settings: {
      model,
      reasoning_effort: normalizeReasoningEffort(policy?.effort),
      developer_instructions: null,
    },
  };
}

function normalizeThreadSummary(item, archived = false) {
  if (!item || typeof item !== 'object') return null;
  const externalThreadId = String(item.id || '').trim();
  if (!externalThreadId) return null;
  const createdAt = Number(item.createdAt);
  const updatedAt = Number(item.updatedAt ?? item.createdAt);
  const archivedState = typeof item.archived === 'boolean' ? item.archived : archived;
  return {
    id: externalThreadId,
    cwd: typeof item.cwd === 'string' ? item.cwd : '',
    path: typeof item.path === 'string' ? item.path : null,
    preview:
      (typeof item.name === 'string' && item.name.trim()) ||
      (typeof item.preview === 'string' && item.preview.trim()) ||
      '',
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
    archived: !!archivedState,
  };
}

function normalizeLoadedThreadIds(response) {
  const raw = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.threadIds)
      ? response.threadIds
      : Array.isArray(response?.thread_ids)
        ? response.thread_ids
        : [];
  const ids = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

function localThreadIdFromExternal(externalThreadId) {
  return `codex_${externalThreadId}`;
}

function normalizeSessionTitle(text, fallback) {
  if (typeof text !== 'string') return fallback;
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return fallback;
  return singleLine.slice(0, 140);
}

function isExistingRolloutPath(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

async function syncThreadMetadataToRelay(client, options = {}) {
  const localThreadId = String(options.localThreadId || '').trim();
  const externalThreadId = String(options.externalThreadId || '').trim();
  if (!localThreadId || !externalThreadId) return;

  const fallbackTitle = `Desktop Thread ${externalThreadId.slice(0, 12)}`;
  let title = fallbackTitle;
  let workspace = String(options.workspace || '').trim();

  try {
    const readResp = await client.request('thread/read', { threadId: externalThreadId }, CONFIG.requestTimeoutMs);
    const summary = normalizeThreadSummary(readResp?.thread || readResp, false);
    if (summary) {
      title = normalizeSessionTitle(summary.preview, fallbackTitle);
      const inferred = inferWorkspaceFromCwd(summary.cwd);
      if (inferred && inferred !== '__unknown__') {
        workspace = inferred;
      }
    }
  } catch (err) {
    logLine(`thread/read metadata sync skipped thread=${externalThreadId} error=${String(err.message || err)}`);
  }

  if (!workspace) {
    workspace = CONFIG.multiWorkspace ? 'default' : CONFIG.workspace;
  }

  const status = String(options.status || 'idle');
  try {
    await relayJson('POST', '/codex-iphone-connector/chat/threads', {
      workspace,
      thread_id: localThreadId,
      title,
      external_thread_id: externalThreadId,
      source: 'codex',
      status,
      updated_at: nowIso(),
    });
  } catch (err) {
    logLine(`relay thread metadata upsert failed thread=${localThreadId} external=${externalThreadId} error=${String(err.message || err)}`);
  }
}

function normalizeThreadListResponse(response) {
  if (Array.isArray(response?.data)) {
    return {
      items: response.data,
      nextCursor: typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : null,
    };
  }
  if (Array.isArray(response?.threads)) {
    return {
      items: response.threads,
      nextCursor: typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null,
    };
  }
  return { items: [], nextCursor: null };
}

function parseSessionMessagesFromJsonl(filePath, limit) {
  if (!filePath || !Number.isFinite(limit) || limit <= 0) return [];
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed.type !== 'response_item') continue;
    const payload = parsed.payload || {};
    if (payload.type !== 'message') continue;
    const role = String(payload.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const normalized = normalizeSessionSyncMessageContent(payload.content || []);
    const text = normalized.text;
    const inputItems = Array.isArray(normalized.inputItems) ? normalized.inputItems : [];
    if (!text && inputItems.length === 0) continue;
    messages.push({
      role,
      text,
      input_items: inputItems,
      ts: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
    });
  }
  if (messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}

function maybeAssistantTextFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  const type = String(item.type || '').toLowerCase();
  if (!type.includes('agent') && !type.includes('assistant')) return '';
  if (typeof item.text === 'string') return item.text;
  const fromContent = extractText(item.content);
  if (fromContent) return fromContent;
  if (item.message && typeof item.message === 'object') {
    const nested = extractText(item.message.content);
    if (nested) return nested;
  }
  return '';
}

function buildThreadStartParams(policy) {
  const params = {};
  if (policy.approvalPolicy) params.approvalPolicy = policy.approvalPolicy;
  if (policy.sandbox) params.sandbox = policy.sandbox;
  const model = normalizeModelName(policy.model);
  if (model) params.model = model;
  if (policy.cwd) params.cwd = policy.cwd;
  if (policy.personality) params.personality = policy.personality;
  return params;
}

function buildThreadResumeParams(threadId, policy) {
  const params = { threadId };
  if (policy.approvalPolicy) params.approvalPolicy = policy.approvalPolicy;
  if (policy.sandbox) params.sandbox = policy.sandbox;
  const model = normalizeModelName(policy.model);
  if (model) params.model = model;
  if (policy.cwd) params.cwd = policy.cwd;
  if (policy.personality) params.personality = policy.personality;
  return params;
}

function normalizeTurnInputItems(inputItems, inputText) {
  const items = [];
  if (Array.isArray(inputItems)) {
    for (const raw of inputItems.slice(0, 12)) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || '').trim();
      if (type === 'text') {
        const text = typeof raw.text === 'string' ? raw.text.trim() : '';
        if (!text) continue;
        items.push({ type: 'text', text });
        continue;
      }
      if (type === 'image') {
        const url = typeof raw.url === 'string' ? raw.url.trim() : '';
        if (!url) continue;
        items.push({ type: 'image', url });
        continue;
      }
      if (type === 'localImage') {
        const imagePath = typeof raw.path === 'string' ? raw.path.trim() : '';
        if (!imagePath) continue;
        items.push({ type: 'localImage', path: imagePath });
        continue;
      }
      if (type === 'skill' || type === 'mention') {
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        const itemPath = typeof raw.path === 'string' ? raw.path.trim() : '';
        if (!name || !itemPath) continue;
        items.push({ type, name, path: itemPath });
      }
    }
  }
  if (!items.length) {
    items.push({
      type: 'text',
      text: String(inputText || '').trim(),
    });
  }
  return items;
}

function buildTurnStartParams(threadId, inputText, inputItems, policy) {
  const params = {
    threadId,
    input: normalizeTurnInputItems(inputItems, inputText),
  };
  const model = normalizeModelName(policy.model);
  if (model) params.model = model;
  if (policy.cwd) params.cwd = policy.cwd;
  if (policy.approvalPolicy) params.approvalPolicy = policy.approvalPolicy;
  if (policy.personality) params.personality = policy.personality;
  const effort = normalizeReasoningEffort(policy.effort);
  if (effort) params.effort = effort;
  const summary = normalizeReasoningSummary(policy.summary);
  if (summary) params.summary = summary;
  const sandboxPolicy = normalizeSandboxPolicy(policy.sandboxPolicy || policy.sandbox);
  if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
  const collaborationMode = normalizeCollaborationMode(policy);
  if (collaborationMode) params.collaborationMode = collaborationMode;
  return params;
}

function normalizeToolRequestUserInputQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const questions = [];
  for (const raw of rawQuestions.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim().slice(0, 120);
    const header = String(raw.header || '').trim().slice(0, 120);
    const question = String(raw.question || '').trim().slice(0, 400);
    if (!id || !header || !question) continue;

    const normalized = { id, header, question };
    if (raw.isOther === true) normalized.isOther = true;
    if (raw.isSecret === true) normalized.isSecret = true;

    if (Array.isArray(raw.options)) {
      const options = [];
      for (const optionRaw of raw.options.slice(0, 8)) {
        if (!optionRaw || typeof optionRaw !== 'object') continue;
        const label = String(optionRaw.label || '').trim().slice(0, 120);
        const description = String(optionRaw.description || '').trim().slice(0, 260);
        if (!label || !description) continue;
        options.push({ label, description });
      }
      if (options.length) normalized.options = options;
    }
    questions.push(normalized);
  }
  return questions;
}

function normalizeToolRequestUserInputAnswers(rawAnswers, expectedQuestions = []) {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) return null;
  const allowedQuestionIds = new Set(
    expectedQuestions
      .map((question) => String(question?.id || '').trim())
      .filter((id) => id.length > 0),
  );
  const answers = {};
  for (const [rawQuestionId, rawAnswer] of Object.entries(rawAnswers).slice(0, 12)) {
    const questionId = String(rawQuestionId || '').trim().slice(0, 120);
    if (!questionId) continue;
    if (allowedQuestionIds.size && !allowedQuestionIds.has(questionId)) continue;

    const answerValues = Array.isArray(rawAnswer?.answers)
      ? rawAnswer.answers
      : Array.isArray(rawAnswer)
        ? rawAnswer
        : (rawAnswer == null ? [] : [rawAnswer]);
    const normalizedValues = answerValues
      .slice(0, 8)
      .map((value) => String(value == null ? '' : value).trim().slice(0, 240))
      .filter((value) => value.length > 0);
    if (!normalizedValues.length) continue;
    answers[questionId] = { answers: normalizedValues };
  }
  return Object.keys(answers).length ? answers : null;
}

function buildRelayUserInputRequestId(jobId, rpcRequestId, itemId = '') {
  const tail = String(rpcRequestId == null ? '' : rpcRequestId).trim() || randomId('ui');
  const itemToken = String(itemId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  const base = itemToken ? `${jobId}_${tail}_${itemToken}` : `${jobId}_${tail}`;
  return String(base).slice(0, 180);
}

async function registerJobUserInputRequest(jobId, payload) {
  const data = await relayJson(
    'POST',
    `/codex-iphone-connector/jobs/${encodeURIComponent(jobId)}/user-input/request`,
    {
      connector_id: CONFIG.connectorId,
      request_id: payload.requestId,
      thread_id: payload.threadId,
      turn_id: payload.turnId || null,
      item_id: payload.itemId || null,
      questions: payload.questions,
    },
  );
  return data.request || null;
}

async function claimJobUserInputRequest(jobId, requestId) {
  const data = await relayJson(
    'POST',
    `/codex-iphone-connector/jobs/${encodeURIComponent(jobId)}/user-input/claim`,
    {
      connector_id: CONFIG.connectorId,
      request_id: requestId,
    },
  );
  return data.request || null;
}

async function waitForJobUserInputAnswer(jobId, requestId, expectedQuestions, shouldAbort) {
  const pollMs = Math.max(600, CONFIG.jobControlPollMs);
  for (;;) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new Error('user input wait aborted');
    }
    let request = null;
    try {
      request = await claimJobUserInputRequest(jobId, requestId);
    } catch (err) {
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        throw new Error('user input wait aborted');
      }
      logLine(`user input claim retry job=${jobId} request=${requestId} error=${String(err.message || err)}`);
      await sleep(pollMs);
      continue;
    }
    if (request && request.answers) {
      const normalized = normalizeToolRequestUserInputAnswers(request.answers, expectedQuestions);
      if (normalized) return normalized;
    }
    await sleep(pollMs);
  }
}

async function claimSessionSyncRequest() {
  const workspace = CONFIG.multiWorkspace ? '*' : CONFIG.workspace;
  const data = await relayJson('POST', '/codex-iphone-connector/sessions/sync/claim', {
    connector_id: CONFIG.connectorId,
    workspace,
  });
  return data.request || null;
}

async function fetchRelayThread(threadId) {
  if (!threadId) return null;
  const data = await relayJson('GET', `/codex-iphone-connector/chat/threads/${encodeURIComponent(threadId)}`);
  return data?.thread || null;
}

function isSessionDeleteRequest(syncRequest) {
  const requestedBy = String(syncRequest?.requested_by || '').toLowerCase();
  return requestedBy.startsWith('ios-delete-thread') || requestedBy.startsWith('mobile-delete-thread');
}

function externalThreadIdForArchive(thread) {
  const explicit = String(thread?.external_thread_id || '').trim();
  if (explicit) return explicit;
  const local = String(thread?.thread_id || '').trim();
  if (local.startsWith('codex_')) return local.slice('codex_'.length);
  return '';
}

function externalThreadIdFromLocalThreadId(localThreadId) {
  const local = String(localThreadId || '').trim();
  if (local.startsWith('codex_')) return local.slice('codex_'.length);
  return '';
}

function isArchiveAlreadyGoneMessage(message) {
  return isSessionNotLoadedText(message);
}

async function processSessionDeleteRequest(client, syncRequest) {
  const localThreadId = String(syncRequest?.thread_id || '').trim();
  if (!localThreadId) return;

  const relayThread = await fetchRelayThread(localThreadId);
  const externalThreadId = externalThreadIdForArchive(relayThread);
  if (!externalThreadId) {
    throw new Error(`missing external_thread_id for thread ${localThreadId}`);
  }

  try {
    await client.request('thread/archive', { threadId: externalThreadId }, CONFIG.requestTimeoutMs);
    logLine(`thread archived local=${localThreadId} external=${externalThreadId}`);
  } catch (err) {
    const message = String(err.message || err);
    if (isArchiveAlreadyGoneMessage(message)) {
      logLine(`thread archive skipped local=${localThreadId} reason=${message}`);
    } else {
      throw err;
    }
  }
}

async function completeSessionSyncRequest(requestId, status, error = null) {
  return relayJson('POST', '/codex-iphone-connector/sessions/sync/complete', {
    connector_id: CONFIG.connectorId,
    request_id: requestId,
    status,
    error,
  });
}

async function claimAuthReloginRequest() {
  const workspace = CONFIG.multiWorkspace ? '*' : CONFIG.workspace;
  const data = await relayJson('POST', '/codex-iphone-connector/auth/relogin/claim', {
    connector_id: CONFIG.connectorId,
    workspace,
  });
  return data.request || null;
}

async function updateAuthReloginProgress(requestId, payload) {
  return relayJson('POST', '/codex-iphone-connector/auth/relogin/progress', {
    connector_id: CONFIG.connectorId,
    request_id: requestId,
    ...payload,
  });
}

async function completeAuthReloginRequest(requestId, status, message = null, error = null) {
  return relayJson('POST', '/codex-iphone-connector/auth/relogin/complete', {
    connector_id: CONFIG.connectorId,
    request_id: requestId,
    status,
    message,
    error,
  });
}

async function registerConnector(status, errorCode, errorMessage) {
  const workspace = CONFIG.multiWorkspace ? '*' : CONFIG.workspace;
  await relayJson('POST', '/codex-iphone-connector/register', {
    connector_id: CONFIG.connectorId,
    workspace,
    version: CONFIG.connectorVersion,
    status,
    capabilities: {
      app_server: true,
      sessions_backfill: true,
      mode: 'chat',
      multi_workspace: CONFIG.multiWorkspace,
      max_concurrent_jobs: CONFIG.maxConcurrentJobs,
    },
    last_error_code: errorCode || null,
    last_error_message: errorMessage || null,
  });
}

async function heartbeatConnector(status, errorCode, errorMessage) {
  const workspace = CONFIG.multiWorkspace ? '*' : CONFIG.workspace;
  await relayJson('POST', '/codex-iphone-connector/heartbeat', {
    connector_id: CONFIG.connectorId,
    workspace,
    version: CONFIG.connectorVersion,
    status,
    capabilities: {
      app_server: true,
      sessions_backfill: true,
      mode: 'chat',
      multi_workspace: CONFIG.multiWorkspace,
      max_concurrent_jobs: CONFIG.maxConcurrentJobs,
    },
    last_error_code: errorCode || null,
    last_error_message: errorMessage || null,
  });
}

function startHeartbeatLoop() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    const status = authHealth.ok ? 'online' : 'degraded';
    void heartbeatConnector(status, authHealth.code, authHealth.message).catch((err) => {
      logLine(`periodic heartbeat error: ${String(err.message || err)}`);
    });
  }, CONFIG.heartbeatSeconds * 1000);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

function stopHeartbeatLoop() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function claimNextJob() {
  const workspace = CONFIG.multiWorkspace ? '*' : CONFIG.workspace;
  const data = await relayJson('POST', '/codex-iphone-connector/jobs/claim', {
    connector_id: CONFIG.connectorId,
    workspace,
  });
  return data.job ? { job: data.job, thread: data.thread } : null;
}

async function waitForInFlightOrPoll(ms) {
  if (!inFlightJobRuns.size) {
    await sleep(ms);
    return;
  }
  await Promise.race([
    Promise.race(Array.from(inFlightJobRuns)),
    sleep(ms),
  ]);
}

async function syncSessionsToRelay(client, force = false, requestedThreadId = null) {
  const nowMs = Date.now();
  if (!force && nowMs - lastSessionSyncAtMs < CONFIG.sessionSyncSeconds * 1000) return;

  const snapshotByExternalId = new Map();
  let snapshotTruncated = false;
  let skippedMissingPath = 0;

  const collectFromThreadList = async (archived) => {
    let cursor = null;
    for (;;) {
      const remaining = Math.max(1, CONFIG.sessionSyncFullScanLimit - snapshotByExternalId.size);
      if (remaining <= 0) {
        snapshotTruncated = true;
        break;
      }
      const params = {
        limit: Math.min(remaining, 100),
        sortKey: 'updated_at',
      };
      if (archived) params.archived = true;
      if (cursor) params.cursor = cursor;
      const response = await client.request('thread/list', params, CONFIG.requestTimeoutMs);
      const page = normalizeThreadListResponse(response);
      if (!page.items.length) break;

      for (const raw of page.items) {
        const summary = normalizeThreadSummary(raw, archived);
        if (!summary) continue;
        // Ignore stale state-db entries that have no rollout path on disk.
        if (!summary.path || !isExistingRolloutPath(summary.path)) {
          skippedMissingPath += 1;
          continue;
        }
        const existing = snapshotByExternalId.get(summary.id);
        if (!existing) {
          snapshotByExternalId.set(summary.id, summary);
          continue;
        }
        const existingUpdatedAt = Number(existing.updatedAt || 0);
        const incomingUpdatedAt = Number(summary.updatedAt || 0);
        if (incomingUpdatedAt >= existingUpdatedAt) {
          snapshotByExternalId.set(summary.id, summary);
        } else if (summary.archived && !existing.archived) {
          snapshotByExternalId.set(summary.id, summary);
        }
      }
      if (!page.nextCursor) break;
      if (snapshotByExternalId.size >= CONFIG.sessionSyncFullScanLimit) {
        snapshotTruncated = true;
        break;
      }
      cursor = page.nextCursor;
    }
  };

  await collectFromThreadList(false);
  if (CONFIG.sessionSyncIncludeArchived) {
    await collectFromThreadList(true);
  }

  let loadedThreadIds = [];
  try {
    const loadedResponse = await client.request('thread/loaded/list', {}, CONFIG.requestTimeoutMs);
    loadedThreadIds = normalizeLoadedThreadIds(loadedResponse);
  } catch (err) {
    logLine(`thread/loaded/list failed: ${String(err.message || err)}`);
  }

  for (const threadId of loadedThreadIds) {
    if (snapshotByExternalId.has(threadId)) continue;
    if (snapshotByExternalId.size >= CONFIG.sessionSyncFullScanLimit) {
      snapshotTruncated = true;
      break;
    }
    try {
      const readResp = await client.request('thread/read', { threadId }, CONFIG.requestTimeoutMs);
      const summary = normalizeThreadSummary(readResp?.thread || readResp, false);
      if (!summary) continue;
      if (!summary.path || !isExistingRolloutPath(summary.path)) {
        skippedMissingPath += 1;
        continue;
      }
      snapshotByExternalId.set(summary.id, summary);
    } catch (err) {
      logLine(`thread/read failed for ${threadId}: ${String(err.message || err)}`);
      continue;
    }
  }

  const requestedLocalThreadId = String(requestedThreadId || '').trim();
  let requestedExternalThreadId = requestedLocalThreadId
    ? externalThreadIdFromLocalThreadId(requestedLocalThreadId)
    : '';
  if (!requestedExternalThreadId && requestedLocalThreadId) {
    try {
      const relayThread = await fetchRelayThread(requestedLocalThreadId);
      requestedExternalThreadId = externalThreadIdForArchive(relayThread);
    } catch (err) {
      logLine(`thread lookup failed for sync request ${requestedLocalThreadId}: ${String(err.message || err)}`);
    }
  }
  if (requestedExternalThreadId && !snapshotByExternalId.has(requestedExternalThreadId)) {
    try {
      const readResp = await client.request('thread/read', { threadId: requestedExternalThreadId }, CONFIG.requestTimeoutMs);
      const summary = normalizeThreadSummary(readResp?.thread || readResp, false);
      if (summary && summary.path && isExistingRolloutPath(summary.path)) {
        snapshotByExternalId.set(summary.id, summary);
      } else if (summary) {
        skippedMissingPath += 1;
      }
    } catch (err) {
      logLine(`thread/read failed for requested sync thread ${requestedExternalThreadId}: ${String(err.message || err)}`);
    }
  }

  const sortedSnapshot = Array.from(snapshotByExternalId.values()).sort((lhs, rhs) => {
    const left = Number(lhs.updatedAt || lhs.createdAt || 0);
    const right = Number(rhs.updatedAt || rhs.createdAt || 0);
    if (left === right) return String(lhs.id).localeCompare(String(rhs.id));
    return right - left;
  });

  const sessions = [];
  const knownThreadIds = [];
  const knownThreadUpdatedAt = new Map();
  for (const item of sortedSnapshot) {
    const externalThreadId = String(item.id || '').trim();
    if (!externalThreadId) continue;
    const localThreadId = localThreadIdFromExternal(externalThreadId);
    knownThreadIds.push(localThreadId);
    const threadUpdatedAt = normalizeUnixSeconds(item.updatedAt || item.createdAt);
    if (threadUpdatedAt != null) {
      knownThreadUpdatedAt.set(localThreadId, threadUpdatedAt);
    }
    const isRequestedThread = requestedLocalThreadId !== ''
      && localThreadId === requestedLocalThreadId;
    if (sessions.length >= CONFIG.sessionSyncMetadataLimit && !isRequestedThread) continue;

    const workspace = inferWorkspaceFromCwd(item.cwd);
    const isKnown = knownSessionThreadIds.has(localThreadId);
    const previousUpdatedAt = knownSessionUpdatedAtByThreadId.get(localThreadId);
    const title = normalizeSessionTitle(
      item.preview,
      `Desktop Thread ${externalThreadId.slice(0, 12)}`,
    );

    let messages = [];
    const perThreadMessageLimit = isRequestedThread
      ? Math.max(CONFIG.sessionSyncMessagesPerThread, CONFIG.sessionSyncRequestedThreadMessages)
      : CONFIG.sessionSyncMessagesPerThread;
    const shouldAttachMessages = perThreadMessageLimit > 0
      && (sessions.length < CONFIG.sessionSyncLimit || isRequestedThread)
      && item.path
      && (
        isRequestedThread
        || !isKnown
        || previousUpdatedAt == null
        || (threadUpdatedAt != null && threadUpdatedAt > previousUpdatedAt)
      );
    if (shouldAttachMessages) {
      messages = parseSessionMessagesFromJsonl(item.path, perThreadMessageLimit);
    }

    sessions.push({
      thread_id: localThreadId,
      workspace,
      title,
      external_thread_id: externalThreadId,
      source: 'codex',
      status: item.archived ? 'archived' : 'idle',
      created_at: toIsoFromUnixSeconds(item.createdAt),
      updated_at: toIsoFromUnixSeconds(item.updatedAt || item.createdAt),
      messages,
    });
  }

  const snapshotComplete = !snapshotTruncated;
  const shouldPrune = CONFIG.sessionSyncPruneMissing && snapshotComplete;
  if (!sessions.length && !shouldPrune) {
    lastSessionSyncAtMs = nowMs;
    return;
  }

  const result = await relayJson('POST', '/codex-iphone-connector/sessions/sync', {
    connector_id: CONFIG.connectorId,
    workspace: CONFIG.multiWorkspace ? '*' : CONFIG.workspace,
    import_messages_if_empty: true,
    prune_missing: shouldPrune,
    snapshot_complete: snapshotComplete,
    known_thread_ids: knownThreadIds,
    sessions,
  });

  if (snapshotComplete) {
    knownSessionThreadIds.clear();
    knownSessionUpdatedAtByThreadId.clear();
    for (const threadId of knownThreadIds) knownSessionThreadIds.add(threadId);
    for (const [threadId, updatedAt] of knownThreadUpdatedAt.entries()) {
      knownSessionUpdatedAtByThreadId.set(threadId, updatedAt);
    }
  } else {
    for (const session of sessions) knownSessionThreadIds.add(session.thread_id);
    for (const session of sessions) {
      const updatedAt = knownThreadUpdatedAt.get(session.thread_id);
      if (updatedAt == null) continue;
      knownSessionUpdatedAtByThreadId.set(session.thread_id, updatedAt);
    }
  }
  while (knownSessionThreadIds.size > 1200) {
    const first = knownSessionThreadIds.values().next().value;
    if (!first) break;
    knownSessionThreadIds.delete(first);
    knownSessionUpdatedAtByThreadId.delete(first);
  }
  while (knownSessionUpdatedAtByThreadId.size > 1200) {
    const first = knownSessionUpdatedAtByThreadId.keys().next().value;
    if (!first) break;
    knownSessionUpdatedAtByThreadId.delete(first);
    knownSessionThreadIds.delete(first);
  }

  writeState({
    last_session_sync_at: nowIso(),
    last_session_sync_count: sessions.length,
    last_session_sync_known_count: knownThreadIds.length,
    last_session_sync_snapshot_complete: snapshotComplete,
    last_session_sync_pruned: Number(result.pruned || 0),
    last_session_sync_imported_messages: Number(result.imported_messages || 0),
    synced_session_thread_ids: Array.from(knownSessionThreadIds),
    synced_session_updated_at_by_thread_id: Object.fromEntries(knownSessionUpdatedAtByThreadId),
  });
  logLine(
    `session sync upserted=${Number(result.upserted || sessions.length)} imported_messages=${Number(result.imported_messages || 0)} pruned=${Number(result.pruned || 0)} sessions=${sessions.length} known=${knownThreadIds.length} skipped_missing_path=${skippedMissingPath} snapshot_complete=${snapshotComplete}`,
  );
  lastSessionSyncAtMs = nowMs;
}

async function postJobEvents(jobId, externalThreadId, turnId, events) {
  if (!events.length) return;
  await relayJson('POST', `/codex-iphone-connector/jobs/${encodeURIComponent(jobId)}/events`, {
    connector_id: CONFIG.connectorId,
    external_thread_id: externalThreadId || null,
    turn_id: turnId || null,
    events,
  });
}

async function completeJob(jobId, status, opts = {}) {
  return relayJson('POST', `/codex-iphone-connector/jobs/${encodeURIComponent(jobId)}/complete`, {
    connector_id: CONFIG.connectorId,
    status,
    turn_id: opts.turnId || null,
    external_thread_id: opts.externalThreadId || null,
    error_code: opts.errorCode || null,
    error_message: opts.errorMessage || null,
  });
}

async function fetchJobControl(jobId) {
  const params = new URLSearchParams({
    connector_id: CONFIG.connectorId,
  });
  return relayJson('GET', `/codex-iphone-connector/jobs/${encodeURIComponent(jobId)}/control?${params.toString()}`);
}

async function ensureAppClient() {
  if (appClient && appClient.isStarted()) return appClient;
  const client = new AppServerClient({
    codexBin: CONFIG.codexBin,
    requestTimeoutMs: CONFIG.requestTimeoutMs,
    clientInfo: {
      name: 'codex_relay_connector',
      title: 'Codex Relay Connector',
      version: CONFIG.connectorVersion,
    },
  });
  client.onStderr((line) => logLine(`app-server stderr: ${line}`));
  await client.start();
  appClient = client;
  return appClient;
}

async function probeAuth(client) {
  try {
    await client.request('thread/list', { limit: 1 }, 30_000);
    authHealth = { ok: true, code: null, message: null };
  } catch (err) {
    const message = String(err.message || err);
    authHealth = {
      ok: false,
      code: isAuthFailureMessage(message) ? 'CODEx_AUTH_UNAVAILABLE' : 'CODEX_APP_SERVER_ERROR',
      message,
    };
  }
  return authHealth;
}

async function runCommandWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: Number.isFinite(code) ? code : null,
        signal: signal || null,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
      });
    });
  });
}

async function runDeviceAuthLogin(requestId) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.codexBin, ['login', '--device-auth'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let done = false;
    let output = '';
    let authUrl = null;
    let userCode = null;
    let expiresAt = null;
    let reportedAwaiting = false;

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`codex login --device-auth timed out after ${CONFIG.authReloginTimeoutMs}ms`));
    }, CONFIG.authReloginTimeoutMs);

    const consumeText = async (text) => {
      const clean = stripAnsi(text);
      output += `${clean}\n`;
      const hints = parseDeviceAuthHints(clean);
      if (!authUrl && hints.authUrl) authUrl = hints.authUrl;
      if (!userCode && hints.userCode) userCode = hints.userCode;
      if (!expiresAt && hints.expiresAt) expiresAt = hints.expiresAt;

      if (!reportedAwaiting && (authUrl || userCode)) {
        reportedAwaiting = true;
        try {
          await updateAuthReloginProgress(requestId, {
            status: 'awaiting_user',
            auth_url: authUrl,
            user_code: userCode,
            expires_at: expiresAt,
            message: 'Open the URL and finish ChatGPT sign-in; request will auto-complete after authorization.',
            error: null,
          });
        } catch (err) {
          logLine(`auth relogin progress upload failed request_id=${requestId} error=${String(err.message || err)}`);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      consumeText(chunk.toString('utf8')).catch(() => {});
    });
    child.stderr.on('data', (chunk) => {
      consumeText(chunk.toString('utf8')).catch(() => {});
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve({
        code: Number.isFinite(code) ? code : null,
        signal: signal || null,
        authUrl,
        userCode,
        expiresAt,
        output,
      });
    });
  });
}

async function processAuthReloginRequest(request) {
  const requestId = request.request_id;
  logLine(`processing auth relogin request_id=${requestId} workspace=${request.workspace}`);
  writeState({
    current_auth_request_id: requestId,
    current_status: 'auth_relogin',
  });

  try {
    await updateAuthReloginProgress(requestId, {
      status: 'claimed',
      message: 'Connector claimed request; preparing device-auth login flow.',
      error: null,
    });

    if (CONFIG.authReloginLogoutFirst) {
      try {
        await runCommandWithTimeout(CONFIG.codexBin, ['logout'], 20_000);
      } catch (logoutErr) {
        logLine(`codex logout warning request_id=${requestId}: ${String(logoutErr.message || logoutErr)}`);
      }
    } else {
      logLine(`auth relogin preserving existing Codex/MCP credentials request_id=${requestId}`);
    }

    const loginResult = await runDeviceAuthLogin(requestId);
    const completed = loginResult.code === 0;
    const outputTail = String(loginResult.output || '')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-8)
      .join('\n')
      .slice(0, 500);

    if (!completed) {
      await completeAuthReloginRequest(
        requestId,
        'failed',
        'Desktop Codex login failed.',
        outputTail || `exit_code=${loginResult.code ?? 'null'} signal=${loginResult.signal ?? 'null'}`,
      );
      throw new Error(`device auth failed request_id=${requestId} code=${loginResult.code} signal=${loginResult.signal}`);
    }

    if (loginResult.authUrl || loginResult.userCode) {
      await updateAuthReloginProgress(requestId, {
        status: 'running',
        auth_url: loginResult.authUrl,
        user_code: loginResult.userCode,
        expires_at: loginResult.expiresAt,
        message: 'Authorization accepted by OpenAI; restarting app-server and validating auth health.',
        error: null,
      });
    }

    if (appClient) {
      try {
        await appClient.stop();
      } catch (stopErr) {
        logLine(`app-server stop warning request_id=${requestId}: ${String(stopErr.message || stopErr)}`);
      } finally {
        appClient = null;
      }
    }

    const client = await ensureAppClient();
    const auth = await probeAuth(client);
    if (!auth.ok) {
      await completeAuthReloginRequest(
        requestId,
        'failed',
        'Desktop auth still unavailable after login.',
        `${auth.code}: ${auth.message}`,
      );
      throw new Error(`auth probe failed after relogin: ${auth.code}: ${auth.message}`);
    }

    await completeAuthReloginRequest(
      requestId,
      'completed',
      'Desktop Codex login is ready.',
      null,
    );
    logLine(`auth relogin completed request_id=${requestId}`);
  } catch (err) {
    const message = String(err.message || err);
    logLine(`auth relogin error request_id=${requestId} message=${message}`);
    try {
      await completeAuthReloginRequest(
        requestId,
        'failed',
        'Desktop Codex login failed.',
        message.slice(0, 500),
      );
    } catch (ackErr) {
      logLine(`auth relogin complete ack failed request_id=${requestId} error=${String(ackErr.message || ackErr)}`);
    }
  } finally {
    writeState({
      current_auth_request_id: null,
      current_status: authHealth.ok ? 'online' : 'degraded',
      auth_ok: authHealth.ok,
      auth_code: authHealth.code,
      auth_message: authHealth.message,
    });
  }
}

function eventBelongsToTurn(params, externalThreadId, turnId) {
  if (!params || typeof params !== 'object') return false;
  const threadMatchCandidate = params.threadId || params.thread_id || null;
  const turnMatchCandidate = params.turnId || params.turn_id || params.turn?.id || null;
  if (!threadMatchCandidate && !turnMatchCandidate) return false;
  if (externalThreadId && threadMatchCandidate && threadMatchCandidate !== externalThreadId) return false;
  if (turnId && turnMatchCandidate && turnMatchCandidate !== turnId) return false;
  return true;
}

const FORWARDED_EVENT_MSG_TYPES = new Set([
  'agent_message',
  'agent_reasoning',
  'context_compacted',
  'token_count',
]);

function passthroughNotificationPayload(method, params) {
  const normalized = normalizeMethod(method);
  if (normalized.includes('token_count') || normalized.includes('rate_limit')) {
    return {
      method: String(method || ''),
      params: params && typeof params === 'object' ? params : {},
    };
  }
  if (normalized !== 'event_msg' || !params || typeof params !== 'object') return null;
  const payload = params.payload && typeof params.payload === 'object' ? params.payload : null;
  if (!payload) return null;
  const payloadTypeRaw = String(payload.type || '').trim();
  const payloadType = payloadTypeRaw.toLowerCase();
  if (!payloadType) return null;
  if (!FORWARDED_EVENT_MSG_TYPES.has(payloadType) && !payloadType.includes('rate_limit')) {
    return null;
  }
  return {
    method: payloadTypeRaw || 'token_count',
    params: payload,
  };
}

async function processClaimedJob(claim) {
  const { job, thread } = claim;
  const policy = job.policy && typeof job.policy === 'object' ? job.policy : {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    personality: 'pragmatic',
  };
  const localThreadId = job.thread_id;
  const jobId = job.job_id;
  let externalThreadId = thread?.external_thread_id || null;
  let turnId = null;
  let client = null;
  let stopPollTimer = null;
  let stopRequestedByUser = false;
  let stopControlInFlight = false;
  let settle = () => {};
  let unsubscribeNotification = () => {};
  let unsubscribeRequest = () => {};
  const completion = new Promise((resolve) => { settle = resolve; });
  const userStopMessage = 'Stopped by user from iPhone.';

  logLine(`processing job=${jobId} local_thread=${localThreadId}`);
  activeJobsById.set(jobId, localThreadId);
  writeRuntimeState('running');

  let eventChain = Promise.resolve();
  const queueEvent = (event) => {
    eventChain = eventChain
      .then(() => postJobEvents(jobId, externalThreadId, turnId, [event]))
      .catch((err) => {
        logLine(
          `job event upload failed job=${jobId} type=${event.type} error=${String(err.message || err)}`,
        );
      });
    return eventChain;
  };

  const requestUserInterrupt = async (requestedBy) => {
    if (stopRequestedByUser) return;
    stopRequestedByUser = true;
    logLine(`job stop requested job=${jobId} requested_by=${String(requestedBy || 'unknown')}`);
    settle({
      status: 'interrupted',
      params: {
        reason: userStopMessage,
        requested_by: requestedBy || null,
      },
    });
    if (client && client.isStarted()) {
      try {
        await client.stop();
      } catch (stopErr) {
        logLine(`app-server stop warning during job interrupt job=${jobId}: ${String(stopErr.message || stopErr)}`);
      }
      if (appClient === client) {
        appClient = null;
      }
    }
  };

  const pollJobControl = async () => {
    if (stopRequestedByUser || stopControlInFlight) return;
    stopControlInFlight = true;
    try {
      const control = await fetchJobControl(jobId);
      if (control?.stop_requested) {
        await requestUserInterrupt(control.stop_requested_by);
      }
    } catch (err) {
      logLine(`job control poll failed job=${jobId} error=${String(err.message || err)}`);
    } finally {
      stopControlInFlight = false;
    }
  };

  try {
    queueEvent({
      type: 'job.started',
      delta: null,
      payload: {
        job_id: jobId,
        input_text: job.input_text,
        input_items: Array.isArray(job.input_items) ? job.input_items : [],
      },
      ts: nowIso(),
    });

    try {
      const initialControl = await fetchJobControl(jobId);
      if (initialControl?.stop_requested) {
        await eventChain;
        await completeJob(jobId, 'interrupted', {
          turnId: null,
          externalThreadId,
          errorCode: 'TURN_INTERRUPTED',
          errorMessage: userStopMessage,
        });
        logLine(`job interrupted before start job=${jobId} requested_by=${String(initialControl.stop_requested_by || 'unknown')}`);
        return;
      }
    } catch (controlErr) {
      logLine(`job control preflight failed job=${jobId} error=${String(controlErr.message || controlErr)}`);
    }

    client = await ensureAppClient();
    const auth = await probeAuth(client);
    if (!auth.ok) {
      throw new Error(`${auth.code}: ${auth.message}`);
    }

    if (externalThreadId) {
      const previousExternalThreadId = externalThreadId;
      let resumed = false;
      try {
        await client.request('thread/resume', buildThreadResumeParams(externalThreadId, policy), CONFIG.requestTimeoutMs);
        resumed = true;
      } catch (resumeErr) {
        if (!isRecoverableResumeError(resumeErr)) {
          throw resumeErr;
        }
        logLine(
          `thread resume failed; attempting recovery local=${localThreadId} external=${previousExternalThreadId} error=${String(resumeErr.message || resumeErr)}`,
        );
        try {
          await syncSessionsToRelay(client, true, localThreadId);
        } catch (syncErr) {
          logLine(`forced session sync failed during resume recovery: ${String(syncErr.message || syncErr)}`);
        }
        const refreshedRelayThread = await fetchRelayThread(localThreadId);
        const refreshedExternalThreadId = String(refreshedRelayThread?.external_thread_id || '').trim();
        if (refreshedExternalThreadId && refreshedExternalThreadId !== previousExternalThreadId) {
          externalThreadId = refreshedExternalThreadId;
          try {
            await client.request('thread/resume', buildThreadResumeParams(externalThreadId, policy), CONFIG.requestTimeoutMs);
            resumed = true;
            logLine(
              `thread resume recovered using refreshed external id local=${localThreadId} external=${externalThreadId}`,
            );
          } catch (retryErr) {
            logLine(
              `thread resume retry failed local=${localThreadId} external=${externalThreadId} error=${String(retryErr.message || retryErr)}`,
            );
          }
        }
        if (!resumed) {
          const started = await client.request('thread/start', buildThreadStartParams(policy), CONFIG.requestTimeoutMs);
          externalThreadId = extractThreadId(started);
          if (!externalThreadId) throw new Error('thread/start missing thread id during resume recovery');
          queueEvent({
            type: 'thread.bound',
            delta: null,
            payload: {
              external_thread_id: externalThreadId,
              recovered_from: previousExternalThreadId,
            },
            ts: nowIso(),
          });
          logLine(
            `thread rebound local=${localThreadId} previous_external=${previousExternalThreadId} new_external=${externalThreadId}`,
          );
        }
      }
    } else {
      const started = await client.request('thread/start', buildThreadStartParams(policy), CONFIG.requestTimeoutMs);
      externalThreadId = extractThreadId(started);
      if (!externalThreadId) throw new Error('thread/start missing thread id');
      queueEvent({
        type: 'thread.bound',
        delta: null,
        payload: { external_thread_id: externalThreadId },
        ts: nowIso(),
      });
    }
    await syncThreadMetadataToRelay(client, {
      localThreadId,
      externalThreadId,
      workspace: thread?.workspace || job.workspace,
      status: 'running',
    });

    unsubscribeRequest = client.onRequest(async ({ id: rpcRequestId, method, params }) => {
      const normalizedMethod = normalizeMethod(method);
      if (normalizedMethod !== 'item/tool/requestuserinput') return undefined;

      const requestParams = params && typeof params === 'object' ? params : {};
      const requestThreadId = String(requestParams.threadId || requestParams.thread_id || '').trim();
      if (externalThreadId && requestThreadId && requestThreadId !== externalThreadId) return undefined;

      const requestTurnId = String(requestParams.turnId || requestParams.turn_id || '').trim();
      if (turnId && requestTurnId && requestTurnId !== turnId) return undefined;

      if (stopRequestedByUser || shuttingDown) {
        throw new Error(userStopMessage);
      }

      const questions = normalizeToolRequestUserInputQuestions(requestParams.questions);
      if (!questions.length) {
        throw new Error('requestUserInput missing valid questions');
      }

      const itemId = String(requestParams.itemId || requestParams.item_id || '').trim() || null;
      const relayRequestId = buildRelayUserInputRequestId(jobId, rpcRequestId, itemId || '');
      const effectiveTurnId = requestTurnId || turnId || null;

      await registerJobUserInputRequest(jobId, {
        requestId: relayRequestId,
        threadId: localThreadId,
        turnId: effectiveTurnId,
        itemId,
        questions,
      });

      const answers = await waitForJobUserInputAnswer(
        jobId,
        relayRequestId,
        questions,
        () => stopRequestedByUser || shuttingDown,
      );

      return { answers };
    });

    const turnResp = await client.request(
      'turn/start',
      buildTurnStartParams(externalThreadId, job.input_text, job.input_items, policy),
      CONFIG.requestTimeoutMs,
    );
    turnId = extractTurnId(turnResp);

    unsubscribeNotification = client.onNotification((method, params) => {
      const normalized = normalizeMethod(method);
      const normalizedParams = params && typeof params === 'object' ? params : {};
      const passthroughEventPayload = passthroughNotificationPayload(method, normalizedParams);
      const passthroughEvent = !!passthroughEventPayload;
      if (!passthroughEvent && !eventBelongsToTurn(normalizedParams, externalThreadId, turnId)) return;

      const eventMethod = passthroughEventPayload?.method || method;
      const eventParams = passthroughEventPayload?.params || normalizedParams;

      queueEvent({
        type: methodToType(eventMethod),
        delta: null,
        payload: { method: eventMethod, params: eventParams },
        ts: nowIso(),
      });

      if (normalized.endsWith('agentmessage/delta') && typeof normalizedParams.delta === 'string' && normalizedParams.delta) {
        queueEvent({
          type: 'assistant.delta',
          delta: normalizedParams.delta,
          payload: null,
          ts: nowIso(),
        });
      }

      if (normalized === 'item/completed') {
        const text = maybeAssistantTextFromItem(normalizedParams.item);
        if (text) {
          queueEvent({
            type: 'assistant.message',
            delta: text,
            payload: null,
            ts: nowIso(),
          });
        }
      }

      if (normalized === 'turn/completed') {
        const status = normalizedParams.turn?.status || 'completed';
        settle({ status, params: normalizedParams });
      }
    });

    await pollJobControl();
    stopPollTimer = setInterval(() => {
      void pollJobControl();
    }, CONFIG.jobControlPollMs);

    let completionResult = null;
    const immediateTurnStatus = String(turnResp?.turn?.status || '');
    const immediateTurnStatusNorm = immediateTurnStatus.toLowerCase();
    if (
      immediateTurnStatus &&
      immediateTurnStatusNorm !== 'running' &&
      immediateTurnStatusNorm !== 'inprogress'
    ) {
      completionResult = { status: immediateTurnStatus, params: turnResp };
    } else {
      completionResult = CONFIG.turnTimeoutMs > 0
        ? await Promise.race([
          completion,
          sleep(CONFIG.turnTimeoutMs).then(() => ({ status: 'timed_out', params: null })),
        ])
        : await completion;
    }
    if (stopPollTimer) {
      clearInterval(stopPollTimer);
      stopPollTimer = null;
    }
    unsubscribeNotification();
    unsubscribeNotification = () => {};
    unsubscribeRequest();
    unsubscribeRequest = () => {};

    await eventChain;

    const completionState = relayCompletionForTurnStatus(completionResult.status, completionResult.params);
    await completeJob(jobId, completionState.relayStatus, {
      turnId,
      externalThreadId,
      errorCode: completionState.errorCode,
      errorMessage: completionState.errorMessage,
    });
    const threadStatus = completionState.relayStatus === 'completed'
      ? 'idle'
      : completionState.relayStatus === 'timeout'
        ? 'failed'
        : completionState.relayStatus;
    await syncThreadMetadataToRelay(client, {
      localThreadId,
      externalThreadId,
      workspace: thread?.workspace || job.workspace,
      status: threadStatus,
    });
    if (completionState.relayStatus === 'completed') {
      logLine(`job completed job=${jobId}`);
    } else {
      logLine(
        `job ${completionState.logLabel} job=${jobId} reason=${completionState.errorMessage || 'turn not completed'}`,
      );
    }
  } catch (err) {
    const code = mapErrorCode(err);
    const message = String(err.message || err);
    logLine(`job error job=${jobId} code=${code} message=${message}`);
    try {
      await completeJob(jobId, 'failed', {
        turnId,
        externalThreadId,
        errorCode: code,
        errorMessage: message,
      });
      if (client && externalThreadId) {
        await syncThreadMetadataToRelay(client, {
          localThreadId,
          externalThreadId,
          workspace: thread?.workspace || job.workspace,
          status: 'failed',
        });
      }
    } catch (completeErr) {
      logLine(`complete failed for job=${jobId}: ${String(completeErr.message || completeErr)}`);
    }
    if (code === 'CODEx_AUTH_UNAVAILABLE') {
      authHealth = { ok: false, code, message };
    }
  } finally {
    if (stopPollTimer) {
      clearInterval(stopPollTimer);
      stopPollTimer = null;
    }
    unsubscribeNotification();
    unsubscribeRequest();
    activeJobsById.delete(jobId);
    writeRuntimeState();
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHeartbeatLoop();
  writeRuntimeState('stopping');
  try {
    await heartbeatConnector('offline', authHealth.code, authHealth.message);
  } catch {
    // ignore
  }
  try {
    if (appClient) await appClient.stop();
  } catch {
    // ignore
  }
}

async function main() {
  if (!CONFIG.relayBaseUrl) throw new Error('RELAY_BASE_URL is required');

  ensureDir(CONFIG.stateDir);
  loadKnownSessionSyncState();
  writeState({
    run_id: randomId('run'),
    current_status: 'starting',
    current_auth_request_id: null,
    max_concurrent_jobs: CONFIG.maxConcurrentJobs,
    active_jobs: [],
    auth_ok: false,
    auth_code: null,
    auth_message: null,
  });
  startHeartbeatLoop();

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  const turnTimeoutLabel = CONFIG.turnTimeoutMs > 0 ? String(CONFIG.turnTimeoutMs) : 'disabled';
  logLine(
    `starting connector_id=${CONFIG.connectorId} workspace=${CONFIG.multiWorkspace ? '*' : CONFIG.workspace} max_concurrent_jobs=${CONFIG.maxConcurrentJobs} turn_timeout_ms=${turnTimeoutLabel}`,
  );

  while (!shuttingDown) {
    try {
      const client = await ensureAppClient();
      await probeAuth(client);

      const status = authHealth.ok ? 'online' : 'degraded';
      await registerConnector(status, authHealth.code, authHealth.message);
      await heartbeatConnector(status, authHealth.code, authHealth.message);
      writeRuntimeState(status);

      if (!authHealth.ok) {
        await waitForInFlightOrPoll(CONFIG.pollSeconds * 1000);
        continue;
      }

      if (activeJobsById.size === 0) {
        let syncRequest = null;
        try {
          syncRequest = await claimSessionSyncRequest();
          const forceSync = !!syncRequest;
          if (syncRequest && isSessionDeleteRequest(syncRequest)) {
            await processSessionDeleteRequest(client, syncRequest);
          }
          const requestedSyncThreadId = String(syncRequest?.thread_id || '').trim();
          await syncSessionsToRelay(client, forceSync, requestedSyncThreadId);
          if (syncRequest) {
            await completeSessionSyncRequest(syncRequest.request_id, 'completed');
            const tag = isSessionDeleteRequest(syncRequest) ? 'delete+sync' : 'sync';
            logLine(`session ${tag} request completed request_id=${syncRequest.request_id} workspace=${syncRequest.workspace}`);
          }
        } catch (syncErr) {
          const syncErrorMessage = String(syncErr.message || syncErr);
          logLine(`session sync error: ${syncErrorMessage}`);
          // Avoid tight retry loops when relay rejects sync payloads (for example 413).
          // Let the normal session sync interval gate the next attempt.
          lastSessionSyncAtMs = Date.now();
          try {
            if (syncRequest) {
              await completeSessionSyncRequest(
                syncRequest.request_id,
                'failed',
                syncErrorMessage,
              );
            }
          } catch {
            // ignore ack failure
          }
        }

        let authReloginRequest = null;
        try {
          authReloginRequest = await claimAuthReloginRequest();
        } catch (authClaimErr) {
          logLine(`auth relogin claim error: ${String(authClaimErr.message || authClaimErr)}`);
        }
        if (authReloginRequest) {
          await processAuthReloginRequest(authReloginRequest);
          continue;
        }
      }

      const slots = Math.max(0, CONFIG.maxConcurrentJobs - activeJobsById.size);
      let claimedCount = 0;
      for (let i = 0; i < slots; i += 1) {
        const claim = await claimNextJob();
        if (!claim) break;
        claimedCount += 1;
        let runPromise = null;
        runPromise = processClaimedJob(claim)
          .catch((jobErr) => {
            logLine(`job run failed unexpectedly: ${String(jobErr.message || jobErr)}`);
          })
          .finally(() => {
            inFlightJobRuns.delete(runPromise);
          });
        inFlightJobRuns.add(runPromise);
      }
      if (claimedCount === 0) {
        await waitForInFlightOrPoll(CONFIG.pollSeconds * 1000);
      }
    } catch (err) {
      const message = String(err.message || err);
      logLine(`loop error: ${message}`);
      authHealth = {
        ok: false,
        code: isAuthFailureMessage(message) ? 'CODEx_AUTH_UNAVAILABLE' : 'CONNECTOR_LOOP_ERROR',
        message,
      };
      writeRuntimeState('error');
      await waitForInFlightOrPoll(Math.max(CONFIG.pollSeconds, 3) * 1000);
    }
  }
}

main().catch(async (err) => {
  logLine(`fatal: ${String(err.message || err)}`);
  stopHeartbeatLoop();
  await shutdown();
  process.exit(1);
});
