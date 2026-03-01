const jwt = require('jsonwebtoken');

function bearerToken(req) {
  const auth = String(req?.headers?.authorization || '').trim();
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice('Bearer '.length).trim();
}

function normalizeTenant(value, fallback = 'legacy') {
  const t = String(value || '').trim();
  return t || fallback;
}

function resolveAuthContext(req, options = {}) {
  const token = bearerToken(req);
  const legacyRelayToken = String(options.legacyRelayToken || '').trim();
  const jwtSecret = String(options.jwtSecret || '').trim();
  const jwtIssuer = String(options.jwtIssuer || '').trim();
  const jwtAudience = String(options.jwtAudience || '').trim();

  if (!token) {
    if (!legacyRelayToken) {
      return { ok: false, error: 'missing_bearer_token' };
    }
    return { ok: false, error: 'missing_bearer_token' };
  }

  if (legacyRelayToken && token === legacyRelayToken) {
    return {
      ok: true,
      context: {
        tenantId: 'legacy',
        actorType: 'legacy',
        userId: null,
        installationId: null,
        tokenType: 'legacy',
        claims: null,
      },
    };
  }

  if (!jwtSecret) {
    return { ok: false, error: 'relay_jwt_secret_not_configured' };
  }

  try {
    const claims = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: jwtIssuer || undefined,
      audience: jwtAudience || undefined,
    });

    const tenantId = normalizeTenant(claims.tenant_id, '');
    if (!tenantId) {
      return { ok: false, error: 'tenant_id_missing' };
    }

    return {
      ok: true,
      context: {
        tenantId,
        actorType: String(claims.token_type || 'unknown').trim() || 'unknown',
        userId: String(claims.user_id || '').trim() || null,
        installationId: String(claims.installation_id || '').trim() || null,
        tokenType: String(claims.token_type || '').trim() || null,
        claims,
      },
    };
  } catch {
    return { ok: false, error: 'invalid_token' };
  }
}

module.exports = {
  resolveAuthContext,
};
