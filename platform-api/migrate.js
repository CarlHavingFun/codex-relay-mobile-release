#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = process.env.CONFIG_ENV_FILE || path.join(ROOT, 'config', '.env');
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const databaseUrl = process.env.PLATFORM_DATABASE_URL;
if (!databaseUrl) {
  console.error('[platform-api:migrate] missing PLATFORM_DATABASE_URL');
  process.exit(1);
}

const dir = path.join(__dirname, 'migrations');
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!sql.trim()) continue;
      console.log(`[platform-api:migrate] applying ${file}`);
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('[platform-api:migrate] done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[platform-api:migrate] failed:', String(err.message || err));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
