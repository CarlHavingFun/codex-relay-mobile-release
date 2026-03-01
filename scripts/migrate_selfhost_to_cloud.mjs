#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const out = {
    relayDbPath: process.env.RELAY_DB_PATH || path.join(ROOT, 'relay', 'data', 'relay.db'),
    platformBaseUrl: process.env.PLATFORM_BASE_URL || process.env.PLATFORM_API_BASE_URL || 'http://127.0.0.1:8791',
    accessToken: process.env.PLATFORM_ACCESS_TOKEN || '',
    batchSize: Math.max(20, Number(process.env.MIGRATION_BATCH_SIZE || 200)),
    source: process.env.MIGRATION_SOURCE || 'selfhost-relay-db',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--relay-db') out.relayDbPath = resolvePath(argv[++i] || '');
    else if (arg === '--platform-base-url') out.platformBaseUrl = String(argv[++i] || '').trim();
    else if (arg === '--access-token') out.accessToken = String(argv[++i] || '').trim();
    else if (arg === '--batch-size') out.batchSize = Math.max(20, Number(argv[++i] || out.batchSize));
    else if (arg === '--source') out.source = String(argv[++i] || out.source).trim();
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

function printHelp() {
  console.log(`Migrate self-host relay data to hosted platform.

Usage:
  node scripts/migrate_selfhost_to_cloud.mjs --relay-db relay/data/relay.db --access-token <mobile-access-token>
`);
}

function stableChecksum(items) {
  const hash = crypto.createHash('sha256');
  for (const item of items) {
    hash.update(JSON.stringify(item));
  }
  return hash.digest('hex');
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

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.accessToken) {
    throw new Error('missing_access_token: use --access-token or PLATFORM_ACCESS_TOKEN');
  }
  if (!fs.existsSync(args.relayDbPath)) {
    throw new Error(`relay_db_not_found:${args.relayDbPath}`);
  }

  const db = new DatabaseSync(args.relayDbPath, { readonly: true });
  const threads = rows(db, `SELECT thread_id, workspace, title, source, status, created_at, updated_at FROM chat_threads ORDER BY updated_at ASC`);
  const events = rows(db, `SELECT thread_id, seq, type, delta, payload_json, ts FROM chat_events ORDER BY id ASC`);

  const chunked = [];
  for (let i = 0; i < threads.length; i += args.batchSize) {
    chunked.push({
      kind: 'threads',
      records: threads.slice(i, i + args.batchSize),
    });
  }
  for (let i = 0; i < events.length; i += args.batchSize) {
    chunked.push({
      kind: 'events',
      records: events.slice(i, i + args.batchSize),
    });
  }

  const checksum = stableChecksum([
    { threads_count: threads.length },
    { events_count: events.length },
  ]);

  let runId = '';
  let sentChunks = 0;
  let importedRecords = 0;

  for (const chunk of chunked) {
    const response = await httpJson(
      'POST',
      `${args.platformBaseUrl}/v1/migration/import`,
      {
        run_id: runId || undefined,
        source: args.source,
        chunks: [chunk],
        checksum,
        finalize: false,
      },
      {
        Authorization: `Bearer ${args.accessToken}`,
      },
    );
    runId = response.run?.id || runId;
    sentChunks += 1;
    importedRecords += chunk.records.length;
  }

  const finalize = await httpJson(
    'POST',
    `${args.platformBaseUrl}/v1/migration/import`,
    {
      run_id: runId || undefined,
      source: args.source,
      chunks: [],
      checksum,
      finalize: true,
    },
    {
      Authorization: `Bearer ${args.accessToken}`,
    },
  );

  console.log('[migrate] done');
  console.log(`run_id: ${finalize.run?.id || runId}`);
  console.log(`threads: ${threads.length}`);
  console.log(`events: ${events.length}`);
  console.log(`sent_chunks: ${sentChunks}`);
  console.log(`sent_records: ${importedRecords}`);
  console.log(`checksum: ${checksum}`);
}

main().catch((err) => {
  console.error(`[migrate] ${String(err.message || err)}`);
  process.exit(1);
});
