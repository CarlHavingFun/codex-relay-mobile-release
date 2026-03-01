#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function defaultAdminEmail() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `admin+${stamp}@codexiphone.local`;
}

function parseArgs(argv) {
  const out = {
    envFile: process.env.CONFIG_ENV_FILE || path.join(ROOT, 'config', '.env'),
    email: defaultAdminEmail(),
    tenantName: 'admin',
    role: 'owner',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env-file') out.envFile = resolvePath(argv[++i] || '');
    else if (arg === '--email') out.email = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--tenant-name') out.tenantName = String(argv[++i] || '').trim();
    else if (arg === '--role') out.role = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Create or upsert a platform admin account (tenant owner).

Usage:
  node scripts/platform-create-admin.mjs [options]

Options:
  --email <email>       Admin email (default: auto-generated admin+timestamp@codexiphone.local)
  --env-file <path>     Config env file (default: config/.env or CONFIG_ENV_FILE)
  --tenant-name <name>  Tenant display name (default: admin)
  --role <role>         Membership role (default: owner)
  -h, --help            Show this help
`);
}

function resolvePath(input) {
  if (!input) return '';
  if (path.isAbsolute(input)) return input;
  return path.join(ROOT, input);
}

function loadEnv(filePath) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ensureUser(client, email) {
  const found = await client.query(
    'SELECT id, email, status FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  if (found.rows[0]) return { user: found.rows[0], created: false };

  const created = await client.query(
    "INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id, email, status",
    [email],
  );
  return { user: created.rows[0], created: true };
}

async function ensureTenant(client, tenantName) {
  const found = await client.query(
    'SELECT id, name FROM tenants WHERE name = $1 ORDER BY created_at ASC LIMIT 1',
    [tenantName],
  );
  if (found.rows[0]) return { tenant: found.rows[0], created: false };

  const created = await client.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
    [tenantName],
  );
  return { tenant: created.rows[0], created: true };
}

async function upsertMembership(client, tenantId, userId, role) {
  await client.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, userId, role],
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const envFromFile = loadEnv(args.envFile);
  const databaseUrl = process.env.PLATFORM_DATABASE_URL || envFromFile.PLATFORM_DATABASE_URL || '';
  const email = args.email;
  const tenantName = args.tenantName || 'admin';
  const role = args.role || 'owner';

  if (!databaseUrl) {
    throw new Error('missing PLATFORM_DATABASE_URL (set env var or provide in env file)');
  }
  if (!email || !validEmail(email)) {
    throw new Error('valid --email is required');
  }
  if (!role) {
    throw new Error('role must not be empty');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { user, created: userCreated } = await ensureUser(client, email);
    const { tenant, created: tenantCreated } = await ensureTenant(client, tenantName);
    await upsertMembership(client, tenant.id, user.id, role);

    await client.query('COMMIT');
    console.log(JSON.stringify({
      ok: true,
      email: user.email,
      user_id: user.id,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      role,
      user_created: userCreated,
      tenant_created: tenantCreated,
      note: 'Auth uses email OTP. This user can login via /v1/auth/email/send-code + /v1/auth/email/verify.',
    }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[platform-create-admin] ${String(err.message || err)}`);
  process.exit(1);
});
