#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { InMemoryRateLimiter } = require('./lib/rate_limit');
const {
  signAccessToken,
  verifyJwt,
  randomToken,
  hashToken,
  expiryDate,
} = require('./lib/jwt');

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

const CONFIG = {
  port: Number(process.env.PLATFORM_API_PORT || 8791),
  maxBodyBytes: Math.max(16_000, Number(process.env.PLATFORM_API_MAX_BODY_BYTES || 2_000_000)),
  databaseUrl: process.env.PLATFORM_DATABASE_URL || '',
  jwtSecret: process.env.PLATFORM_JWT_SECRET || process.env.RELAY_JWT_SECRET || process.env.RELAY_TOKEN || '',
  jwtIssuer: process.env.PLATFORM_JWT_ISSUER || 'codex-platform',
  mobileAudience: process.env.PLATFORM_JWT_MOBILE_AUDIENCE || 'mobile-app',
  relayAudience: process.env.PLATFORM_JWT_RELAY_AUDIENCE || 'relay-api',
  accessTtlSeconds: Math.max(60, Number(process.env.PLATFORM_ACCESS_TOKEN_TTL_SECONDS || 900)),
  refreshTtlSeconds: Math.max(3600, Number(process.env.PLATFORM_REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 3600)),
  otpTtlSeconds: Math.max(60, Number(process.env.PLATFORM_OTP_TTL_SECONDS || 300)),
  pairingTtlSeconds: Math.max(60, Number(process.env.PLATFORM_PAIRING_TTL_SECONDS || 300)),
  relayBaseUrl: String(process.env.PLATFORM_RELAY_BASE_URL || process.env.RELAY_BASE_URL || '').trim().replace(/\/$/, ''),
  publicBaseUrl: String(process.env.PLATFORM_PUBLIC_BASE_URL || '').trim().replace(/\/$/, ''),
  pairingStartRequireMobileAuth: String(process.env.PLATFORM_PAIRING_START_REQUIRE_MOBILE_AUTH || '0').trim() === '1',
  devMode: String(process.env.PLATFORM_DEV_MODE || '0').trim() === '1',
};

if (!CONFIG.databaseUrl) {
  console.error('[platform-api] missing PLATFORM_DATABASE_URL');
  process.exit(1);
}
if (!CONFIG.jwtSecret) {
  console.error('[platform-api] missing PLATFORM_JWT_SECRET (or RELAY_JWT_SECRET)');
  process.exit(1);
}
if (!CONFIG.relayBaseUrl) {
  console.error('[platform-api] missing PLATFORM_RELAY_BASE_URL (or RELAY_BASE_URL)');
  process.exit(1);
}

const pool = new Pool({ connectionString: CONFIG.databaseUrl });
const rateLimiter = new InMemoryRateLimiter();

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(body));
}

function badRequest(res, message) {
  json(res, 400, { ok: false, error: message });
}

function unauthorized(res, message = 'unauthorized') {
  json(res, 401, { ok: false, error: message });
}

function tooMany(res, message = 'rate_limited') {
  json(res, 429, { ok: false, error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > CONFIG.maxBodyBytes) {
        done = true;
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      if (!total) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        resolve(parsed || {});
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (done) return;
      reject(err);
    });
  });
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return ok ? email : '';
}

function issuePlatformAccessToken({ tenantId, userId }) {
  return signAccessToken({
    secret: CONFIG.jwtSecret,
    issuer: CONFIG.jwtIssuer,
    audience: CONFIG.mobileAudience,
    tenantId,
    userId,
    tokenType: 'mobile',
    expiresInSeconds: CONFIG.accessTtlSeconds,
  });
}

function issueRelayToken({ tenantId, userId, installationId, tokenType }) {
  return signAccessToken({
    secret: CONFIG.jwtSecret,
    issuer: CONFIG.jwtIssuer,
    audience: CONFIG.relayAudience,
    tenantId,
    userId: userId || null,
    tokenType,
    expiresInSeconds: CONFIG.refreshTtlSeconds,
    extraClaims: installationId ? { installation_id: installationId } : {},
  });
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const host = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = forwardedProto || 'http';
  return `${proto}://${host}`.replace(/\/$/, '');
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ensureUserAndTenant(client, email) {
  let user = null;
  {
    const r = await client.query('SELECT id, email, status FROM users WHERE email = $1 LIMIT 1', [email]);
    user = r.rows[0] || null;
  }
  if (!user) {
    const created = await client.query(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id, email, status`,
      [email],
    );
    user = created.rows[0];
  }

  const member = await client.query(
    `SELECT tm.tenant_id AS id
     FROM tenant_memberships tm
     WHERE tm.user_id = $1
     ORDER BY tm.created_at ASC
     LIMIT 1`,
    [user.id],
  );
  let tenant = member.rows[0] || null;

  if (!tenant) {
    const defaultName = `tenant-${email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'user'}`;
    const createdTenant = await client.query(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id, name`,
      [defaultName],
    );
    tenant = createdTenant.rows[0];

    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [tenant.id, user.id],
    );
  }

  return {
    user,
    tenant,
  };
}

async function createRefreshSession(client, { tenantId, userId, rawToken }) {
  const tokenHash = hashToken(rawToken);
  const expiresAt = expiryDate(CONFIG.refreshTtlSeconds);
  await client.query(
    `INSERT INTO refresh_sessions (tenant_id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, tokenHash, expiresAt.toISOString()],
  );
}

function extractBearerToken(req) {
  const value = String(req.headers.authorization || '').trim();
  if (!value.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length).trim();
}

function authFromReq(req, { audience }) {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const payload = verifyJwt(token, {
      secret: CONFIG.jwtSecret,
      issuer: CONFIG.jwtIssuer,
      audience,
    });
    return {
      token,
      tenantId: String(payload.tenant_id || '').trim(),
      userId: String(payload.user_id || '').trim() || null,
      tokenType: String(payload.token_type || '').trim(),
      installationId: String(payload.installation_id || '').trim() || null,
      payload,
    };
  } catch {
    return null;
  }
}

function sixDigitOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function createOtp(client, { email, tenantId, code }) {
  const expiresAt = expiryDate(CONFIG.otpTtlSeconds);
  await client.query(
    `INSERT INTO auth_otps (email, tenant_id, otp_code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email, tenantId || null, hashToken(code), expiresAt.toISOString()],
  );
  return expiresAt.toISOString();
}

async function consumeOtp(client, { email, code }) {
  const rowResp = await client.query(
    `SELECT id, tenant_id, otp_code_hash, expires_at, consumed_at, attempts
     FROM auth_otps
     WHERE email = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [email],
  );
  const row = rowResp.rows[0];
  if (!row) return { ok: false, reason: 'otp_not_found' };
  if (row.consumed_at) return { ok: false, reason: 'otp_used' };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'otp_expired' };

  const codeOk = hashToken(code) === row.otp_code_hash;
  if (!codeOk) {
    await client.query(
      `UPDATE auth_otps SET attempts = attempts + 1 WHERE id = $1`,
      [row.id],
    );
    return { ok: false, reason: 'otp_invalid' };
  }

  await client.query(
    `UPDATE auth_otps SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL`,
    [row.id],
  );

  return {
    ok: true,
    tenantId: row.tenant_id || null,
  };
}

async function createPairingCode(client, { tenantId, installationName, platform }) {
  const installationResp = await client.query(
    `INSERT INTO desktop_installations (tenant_id, installation_name, platform, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id, tenant_id, installation_name, platform, status, created_at`,
    [tenantId, installationName, platform],
  );
  const installation = installationResp.rows[0];

  const setupCode = `pc_${randomToken(12)}`;
  const pollToken = randomToken(24);
  const expiresAt = expiryDate(CONFIG.pairingTtlSeconds);
  await client.query(
    `INSERT INTO pairing_codes (code, tenant_id, installation_id, setup_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [setupCode, tenantId, installation.id, hashToken(pollToken), expiresAt.toISOString()],
  );

  return {
    setupCode,
    pollToken,
    expiresAt: expiresAt.toISOString(),
    installation,
  };
}

async function loadPairingCode(client, setupCode) {
  const resp = await client.query(
    `SELECT code, tenant_id, installation_id, setup_token_hash, expires_at, consumed_at, created_at
     FROM pairing_codes
     WHERE code = $1
     LIMIT 1`,
    [setupCode],
  );
  return resp.rows[0] || null;
}

async function issueApiKeyRecord(client, { tenantId, actorType, actorId, rawToken }) {
  const keyHash = hashToken(rawToken);
  const prefix = `ck_${rawToken.slice(0, 8)}`;
  await client.query(
    `INSERT INTO api_keys (tenant_id, actor_type, actor_id, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, actorType, actorId || null, prefix, keyHash],
  );
}

function relaySetupDeepLink(setupCode, expIso, platformBaseUrl) {
  const params = [
    `v=2`,
    `setup_code=${encodeURIComponent(setupCode)}`,
    `exp=${encodeURIComponent(expIso)}`,
  ];
  const normalizedPlatformBaseUrl = String(platformBaseUrl || '').trim();
  if (normalizedPlatformBaseUrl) {
    params.push(`platform_base_url=${encodeURIComponent(normalizedPlatformBaseUrl)}`);
  }
  return `codexrelay://setup?${params.join('&')}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, { ok: true, ts: nowIso() });
    return;
  }

  try {
    if (req.method === 'POST' && url.pathname === '/v1/auth/email/send-code') {
      const body = await parseBody(req);
      const email = normalizeEmail(body.email);
      if (!email) {
        badRequest(res, 'valid email is required');
        return;
      }

      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').slice(0, 120);
      const rl = rateLimiter.hit(`otp:${ip}:${email}`, { windowSeconds: 600, limit: 6 });
      if (!rl.allowed) {
        tooMany(res, 'otp_rate_limited');
        return;
      }

      const result = await withTx(async (client) => {
        const context = await ensureUserAndTenant(client, email);
        const code = sixDigitOtp();
        const expiresAt = await createOtp(client, { email, tenantId: context.tenant.id, code });
        return { context, code, expiresAt };
      });

      const payload = {
        ok: true,
        email,
        expires_at: result.expiresAt,
        ts: nowIso(),
      };
      if (CONFIG.devMode) payload.dev_code = result.code;
      json(res, 200, payload);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/email/verify') {
      const body = await parseBody(req);
      const email = normalizeEmail(body.email);
      const code = String(body.code || '').trim();
      if (!email || !code) {
        badRequest(res, 'email and code are required');
        return;
      }

      const authPayload = await withTx(async (client) => {
        const consumed = await consumeOtp(client, { email, code });
        if (!consumed.ok) {
          return consumed;
        }

        const context = await ensureUserAndTenant(client, email);
        const refreshToken = randomToken(48);
        await createRefreshSession(client, {
          tenantId: context.tenant.id,
          userId: context.user.id,
          rawToken: refreshToken,
        });

        const accessToken = issuePlatformAccessToken({
          tenantId: context.tenant.id,
          userId: context.user.id,
        });

        return {
          ok: true,
          tenantId: context.tenant.id,
          userId: context.user.id,
          accessToken,
          refreshToken,
          expiresAt: expiryDate(CONFIG.accessTtlSeconds).toISOString(),
        };
      });

      if (!authPayload.ok) {
        unauthorized(res, authPayload.reason || 'verify_failed');
        return;
      }

      json(res, 200, {
        ok: true,
        tenant_id: authPayload.tenantId,
        user_id: authPayload.userId,
        access_token: authPayload.accessToken,
        refresh_token: authPayload.refreshToken,
        expires_at: authPayload.expiresAt,
        token_type: 'Bearer',
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/refresh') {
      const body = await parseBody(req);
      const refreshToken = String(body.refresh_token || '').trim();
      if (!refreshToken) {
        badRequest(res, 'refresh_token is required');
        return;
      }

      const refreshed = await withTx(async (client) => {
        const tokenHash = hashToken(refreshToken);
        const rowResp = await client.query(
          `SELECT rs.id, rs.tenant_id, rs.user_id, rs.expires_at, rs.revoked_at
           FROM refresh_sessions rs
           WHERE rs.refresh_token_hash = $1
           LIMIT 1`,
          [tokenHash],
        );
        const row = rowResp.rows[0] || null;
        if (!row) return { ok: false, reason: 'refresh_not_found' };
        if (row.revoked_at) return { ok: false, reason: 'refresh_revoked' };
        if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'refresh_expired' };

        await client.query(
          `UPDATE refresh_sessions SET revoked_at = NOW(), last_used_at = NOW() WHERE id = $1`,
          [row.id],
        );

        const nextRefresh = randomToken(48);
        await createRefreshSession(client, {
          tenantId: row.tenant_id,
          userId: row.user_id,
          rawToken: nextRefresh,
        });

        const accessToken = issuePlatformAccessToken({
          tenantId: row.tenant_id,
          userId: row.user_id,
        });

        return {
          ok: true,
          tenantId: row.tenant_id,
          userId: row.user_id,
          accessToken,
          refreshToken: nextRefresh,
        };
      });

      if (!refreshed.ok) {
        unauthorized(res, refreshed.reason || 'refresh_failed');
        return;
      }

      json(res, 200, {
        ok: true,
        tenant_id: refreshed.tenantId,
        user_id: refreshed.userId,
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at: expiryDate(CONFIG.accessTtlSeconds).toISOString(),
        token_type: 'Bearer',
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/pairing/desktop/start') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').slice(0, 120);
      const rl = rateLimiter.hit(`pairing_start:${ip}`, { windowSeconds: 300, limit: 30 });
      if (!rl.allowed) {
        tooMany(res, 'pairing_start_rate_limited');
        return;
      }

      const auth = authFromReq(req, { audience: CONFIG.mobileAudience });
      if (CONFIG.pairingStartRequireMobileAuth && (!auth || !auth.tenantId || !auth.userId)) {
        unauthorized(res, 'mobile_auth_required');
        return;
      }
      const tenantId = auth && auth.tenantId ? auth.tenantId : null;

      const body = await parseBody(req);
      const installationName = String(body.installation_name || body.hostname || 'desktop-agent').trim().slice(0, 120) || 'desktop-agent';
      const platform = String(body.platform || process.platform || 'unknown').trim().slice(0, 40) || 'unknown';

      const pairing = await withTx(async (client) => createPairingCode(client, {
        tenantId,
        installationName,
        platform,
      }));
      const platformBaseUrl = CONFIG.publicBaseUrl || requestBaseUrl(req);

      const response = {
        ok: true,
        tenant_id: tenantId,
        installation: pairing.installation,
        setup_code: pairing.setupCode,
        poll_token: pairing.pollToken,
        expires_at: pairing.expiresAt,
        setup_url: relaySetupDeepLink(pairing.setupCode, pairing.expiresAt, platformBaseUrl),
        ts: nowIso(),
      };
      if (platformBaseUrl) {
        response.platform_base_url = platformBaseUrl;
      }

      json(res, 200, response);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/pairing/desktop/confirm') {
      const auth = authFromReq(req, { audience: CONFIG.mobileAudience });
      if (!auth || !auth.tenantId || !auth.userId) {
        unauthorized(res, 'mobile_auth_required');
        return;
      }

      const body = await parseBody(req);
      const setupCode = String(body.setup_code || '').trim();
      if (!setupCode) {
        badRequest(res, 'setup_code is required');
        return;
      }

      const result = await withTx(async (client) => {
        let pairing = await loadPairingCode(client, setupCode);
        if (!pairing) return { ok: false, reason: 'setup_code_not_found' };
        if (pairing.tenant_id && pairing.tenant_id !== auth.tenantId) return { ok: false, reason: 'setup_code_tenant_mismatch' };
        if (pairing.consumed_at) return { ok: false, reason: 'setup_code_used' };
        if (Date.parse(pairing.expires_at) <= Date.now()) return { ok: false, reason: 'setup_code_expired' };

        if (!pairing.tenant_id) {
          await client.query(
            `UPDATE pairing_codes
             SET tenant_id = $1
             WHERE code = $2 AND tenant_id IS NULL`,
            [auth.tenantId, setupCode],
          );
          await client.query(
            `UPDATE desktop_installations
             SET tenant_id = $1
             WHERE id = $2 AND tenant_id IS NULL`,
            [auth.tenantId, pairing.installation_id],
          );
          pairing = {
            ...pairing,
            tenant_id: auth.tenantId,
          };
        }
        const tenantId = String(pairing.tenant_id || auth.tenantId || '').trim();
        if (!tenantId) return { ok: false, reason: 'setup_code_tenant_missing' };

        await client.query(
          `UPDATE pairing_codes SET consumed_at = NOW() WHERE code = $1 AND consumed_at IS NULL`,
          [setupCode],
        );

        await client.query(
          `UPDATE desktop_installations
           SET status = 'active', last_seen_at = NOW()
           WHERE id = $1`,
          [pairing.installation_id],
        );

        const relayMobileToken = issueRelayToken({
          tenantId,
          userId: auth.userId,
          tokenType: 'mobile',
        });

        const connectorToken = issueRelayToken({
          tenantId,
          userId: null,
          installationId: pairing.installation_id,
          tokenType: 'connector',
        });

        await issueApiKeyRecord(client, {
          tenantId,
          actorType: 'connector',
          actorId: pairing.installation_id,
          rawToken: connectorToken,
        });

        return {
          ok: true,
          installationId: pairing.installation_id,
          relayMobileToken,
          connectorToken,
        };
      });

      if (!result.ok) {
        unauthorized(res, result.reason || 'confirm_failed');
        return;
      }

      json(res, 200, {
        ok: true,
        tenant_id: auth.tenantId,
        user_id: auth.userId,
        relay: {
          base_url: CONFIG.relayBaseUrl,
          token: result.relayMobileToken,
          workspace: '*',
        },
        desktop: {
          installation_id: result.installationId,
          connector_token: result.connectorToken,
          token_type: 'Bearer',
        },
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/pairing/desktop/claim') {
      const body = await parseBody(req);
      const setupCode = String(body.setup_code || '').trim();
      const pollToken = String(body.poll_token || '').trim();
      if (!setupCode || !pollToken) {
        badRequest(res, 'setup_code and poll_token are required');
        return;
      }

      const result = await withTx(async (client) => {
        const pairing = await loadPairingCode(client, setupCode);
        if (!pairing) return { ok: false, reason: 'setup_code_not_found' };
        if (hashToken(pollToken) !== pairing.setup_token_hash) return { ok: false, reason: 'poll_token_invalid' };
        if (Date.parse(pairing.expires_at) <= Date.now()) return { ok: false, reason: 'setup_code_expired' };
        if (!pairing.consumed_at) {
          return { ok: true, status: 'pending' };
        }
        const tenantId = String(pairing.tenant_id || '').trim();
        if (!tenantId) {
          return { ok: false, reason: 'setup_code_not_bound' };
        }

        const connectorToken = issueRelayToken({
          tenantId,
          userId: null,
          installationId: pairing.installation_id,
          tokenType: 'connector',
        });
        await issueApiKeyRecord(client, {
          tenantId,
          actorType: 'connector',
          actorId: pairing.installation_id,
          rawToken: connectorToken,
        });

        await client.query(
          `UPDATE desktop_installations SET status = 'active', last_seen_at = NOW() WHERE id = $1`,
          [pairing.installation_id],
        );

        return {
          ok: true,
          status: 'ready',
          tenantId,
          installationId: pairing.installation_id,
          connectorToken,
        };
      });

      if (!result.ok) {
        unauthorized(res, result.reason || 'claim_failed');
        return;
      }

      if (result.status === 'pending') {
        json(res, 200, { ok: true, status: 'pending', ts: nowIso() });
        return;
      }

      json(res, 200, {
        ok: true,
        status: 'ready',
        tenant_id: result.tenantId,
        installation_id: result.installationId,
        relay_base_url: CONFIG.relayBaseUrl,
        connector_token: result.connectorToken,
        token_type: 'Bearer',
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/bootstrap/mobile') {
      const auth = authFromReq(req, { audience: CONFIG.mobileAudience });
      if (!auth || !auth.tenantId || !auth.userId) {
        unauthorized(res, 'mobile_auth_required');
        return;
      }

      const relayToken = issueRelayToken({
        tenantId: auth.tenantId,
        userId: auth.userId,
        tokenType: 'mobile',
      });

      json(res, 200, {
        ok: true,
        tenant_id: auth.tenantId,
        relay_base_url: CONFIG.relayBaseUrl,
        relay_token: relayToken,
        workspace: '*',
        write_workspace: '',
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/migration/import') {
      const auth = authFromReq(req, { audience: CONFIG.mobileAudience });
      if (!auth || !auth.tenantId || !auth.userId) {
        unauthorized(res, 'mobile_auth_required');
        return;
      }

      const body = await parseBody(req);
      const source = String(body.source || 'selfhost').trim().slice(0, 120) || 'selfhost';
      const chunks = Array.isArray(body.chunks) ? body.chunks.slice(0, 1000) : [];
      const checksum = String(body.checksum || '').trim().slice(0, 128) || null;
      const runId = String(body.run_id || '').trim();
      const finalize = body.finalize === true;

      const out = await withTx(async (client) => {
        let id = runId;
        if (!id) {
          const created = await client.query(
            `INSERT INTO migration_import_runs (tenant_id, source, chunks_count, imported_records, checksum, status)
             VALUES ($1, $2, 0, 0, $3, 'running')
             RETURNING id`,
            [auth.tenantId, source, checksum],
          );
          id = created.rows[0].id;
        }

        let importedRecords = 0;
        for (const chunk of chunks) {
          if (!chunk || typeof chunk !== 'object') continue;
          const records = Array.isArray(chunk.records) ? chunk.records.length : 0;
          importedRecords += records;
        }

        await client.query(
          `UPDATE migration_import_runs
           SET chunks_count = chunks_count + $1,
               imported_records = imported_records + $2,
               checksum = COALESCE($3, checksum),
               status = CASE WHEN $4 THEN 'completed' ELSE status END,
               completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END
           WHERE id = $5 AND tenant_id = $6`,
          [chunks.length, importedRecords, checksum, finalize, id, auth.tenantId],
        );

        const row = await client.query(
          `SELECT id, tenant_id, source, chunks_count, imported_records, checksum, status, created_at, completed_at
           FROM migration_import_runs
           WHERE id = $1 AND tenant_id = $2
           LIMIT 1`,
          [id, auth.tenantId],
        );
        return row.rows[0] || null;
      });

      json(res, 200, {
        ok: true,
        run: out,
        ts: nowIso(),
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    const message = String(err?.message || err);
    if (message.toLowerCase().includes('payload too large')) {
      json(res, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    json(res, 500, { ok: false, error: message });
  }
});

server.listen(CONFIG.port, () => {
  console.log(`[platform-api] listening on :${CONFIG.port}`);
  console.log('[platform-api] relay base url:', CONFIG.relayBaseUrl);
  console.log('[platform-api] dev mode:', CONFIG.devMode ? 'on' : 'off');
});
