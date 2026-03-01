#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const out = {
    mode: 'start',
    platformBaseUrl: process.env.PLATFORM_BASE_URL || process.env.PLATFORM_API_BASE_URL || 'http://127.0.0.1:8791',
    platformAccessToken: process.env.PLATFORM_ACCESS_TOKEN || '',
    setupCode: process.env.SETUP_CODE || '',
    pollToken: process.env.POLL_TOKEN || '',
    relayEnvFile: process.env.CONFIG_ENV_FILE || path.join(ROOT, 'config', '.env'),
    stateFile: path.join(ROOT, 'state', 'pairing', 'desktop_pairing_session.json'),
    qrOut: path.join(ROOT, 'state', 'relay_setup', 'relay_setup_qr_v2.png'),
    waitSeconds: Math.max(5, Number(process.env.PAIRING_WAIT_SECONDS || 180)),
    pollIntervalSeconds: Math.max(2, Number(process.env.PAIRING_POLL_INTERVAL_SECONDS || 3)),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--start') out.mode = 'start';
    else if (arg === '--claim') out.mode = 'claim';
    else if (arg === '--wait') out.mode = 'wait';
    else if (arg === '--platform-base-url') out.platformBaseUrl = String(argv[++i] || '').trim();
    else if (arg === '--access-token') out.platformAccessToken = String(argv[++i] || '').trim();
    else if (arg === '--setup-code') out.setupCode = String(argv[++i] || '').trim();
    else if (arg === '--poll-token') out.pollToken = String(argv[++i] || '').trim();
    else if (arg === '--state-file') out.stateFile = resolvePath(argv[++i] || '');
    else if (arg === '--env-file') out.relayEnvFile = resolvePath(argv[++i] || '');
    else if (arg === '--qr-out') out.qrOut = resolvePath(argv[++i] || '');
    else if (arg === '--wait-seconds') out.waitSeconds = Math.max(5, Number(argv[++i] || out.waitSeconds));
    else if (arg === '--poll-interval-seconds') out.pollIntervalSeconds = Math.max(2, Number(argv[++i] || out.pollIntervalSeconds));
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  out.platformBaseUrl = out.platformBaseUrl.replace(/\/$/, '');
  return out;
}

function resolvePath(input) {
  if (!input) return '';
  if (path.isAbsolute(input)) return input;
  return path.join(ROOT, input);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function printHelp() {
  console.log(`Desktop pairing for hosted platform.

Modes:
  --start   Start pairing session and generate setup QR
  --claim   Claim connector token once mobile confirm has completed
  --wait    Poll claim endpoint until ready, then write relay token into env file

Examples:
  node scripts/desktop-pairing.mjs --start
  node scripts/desktop-pairing.mjs --start --access-token <mobile-access-token>
  node scripts/desktop-pairing.mjs --wait --env-file config/.env
`);
}

async function httpJson(method, url, body, headers = {}) {
  const reqHeaders = { Accept: 'application/json', ...headers };
  if (body != null) reqHeaders['Content-Type'] = 'application/json';
  const resp = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok || parsed.ok === false) {
    throw new Error(`${method} ${url} failed: ${resp.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function loadState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(filePath, state) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function upsertEnv(filePath, key, value) {
  const line = `${key}=${value}`;
  let lines = [];
  if (fs.existsSync(filePath)) {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  }
  let found = false;
  const out = lines.map((item) => {
    if (item.startsWith(`${key}=`)) {
      found = true;
      return line;
    }
    return item;
  });
  if (!found) out.push(line);
  ensureDir(filePath);
  fs.writeFileSync(filePath, out.filter((item, idx) => !(idx === out.length - 1 && item === '')).join('\n') + '\n');
}

async function startPairing(args) {
  const headers = {};
  if (args.platformAccessToken) {
    headers.Authorization = `Bearer ${args.platformAccessToken}`;
  }

  const payload = await httpJson(
    'POST',
    `${args.platformBaseUrl}/v1/pairing/desktop/start`,
    {
      installation_name: os.hostname(),
      platform: process.platform,
    },
    headers,
  );

  const state = {
    platform_base_url: args.platformBaseUrl,
    setup_code: payload.setup_code,
    poll_token: payload.poll_token,
    setup_url: payload.setup_url,
    expires_at: payload.expires_at,
    installation: payload.installation || null,
    created_at: new Date().toISOString(),
  };
  saveState(args.stateFile, state);

  ensureDir(args.qrOut);
  await QRCode.toFile(args.qrOut, payload.setup_url, {
    type: 'png',
    width: 768,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  console.log('[desktop-pairing] start ok');
  console.log(`state: ${args.stateFile}`);
  console.log(`qr: ${args.qrOut}`);
  console.log(`setup_url: ${payload.setup_url}`);
  console.log(`expires_at: ${payload.expires_at}`);
}

function stateWithOverrides(args) {
  const saved = loadState(args.stateFile) || {};
  return {
    platform_base_url: args.platformBaseUrl || saved.platform_base_url || '',
    setup_code: args.setupCode || saved.setup_code || '',
    poll_token: args.pollToken || saved.poll_token || '',
    setup_url: saved.setup_url || '',
    expires_at: saved.expires_at || '',
  };
}

async function claimPairing(args) {
  const state = stateWithOverrides(args);
  if (!state.platform_base_url || !state.setup_code || !state.poll_token) {
    throw new Error('missing_pairing_state: run --start first or provide --setup-code/--poll-token');
  }

  const payload = await httpJson(
    'POST',
    `${state.platform_base_url}/v1/pairing/desktop/claim`,
    {
      setup_code: state.setup_code,
      poll_token: state.poll_token,
    },
  );

  if (payload.status !== 'ready') {
    console.log('[desktop-pairing] still pending');
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  upsertEnv(args.relayEnvFile, 'RELAY_BASE_URL', payload.relay_base_url);
  upsertEnv(args.relayEnvFile, 'RELAY_TOKEN', payload.connector_token);
  upsertEnv(args.relayEnvFile, 'CONNECTOR_WORKSPACE', '*');
  upsertEnv(args.relayEnvFile, 'DEFAULT_WORKSPACE', 'default');

  console.log('[desktop-pairing] ready, env updated');
  console.log(`env: ${args.relayEnvFile}`);
  console.log(`relay_base_url: ${payload.relay_base_url}`);
  return payload;
}

async function waitForReady(args) {
  const deadline = Date.now() + args.waitSeconds * 1000;
  while (Date.now() <= deadline) {
    const response = await claimPairing(args);
    if (response && response.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, args.pollIntervalSeconds * 1000));
  }
  throw new Error('pairing_wait_timeout');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'start') {
    await startPairing(args);
    return;
  }
  if (args.mode === 'claim') {
    await claimPairing(args);
    return;
  }
  if (args.mode === 'wait') {
    await waitForReady(args);
    return;
  }
  throw new Error(`unsupported_mode:${args.mode}`);
}

main().catch((err) => {
  console.error(`[desktop-pairing] ${String(err.message || err)}`);
  process.exit(1);
});
