const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function signAccessToken({
  secret,
  issuer,
  audience,
  tenantId,
  userId,
  tokenType,
  expiresInSeconds,
  extraClaims = {},
}) {
  return jwt.sign(
    {
      tenant_id: tenantId,
      user_id: userId || null,
      token_type: tokenType,
      ...extraClaims,
    },
    secret,
    {
      algorithm: 'HS256',
      issuer,
      audience,
      expiresIn: expiresInSeconds,
    },
  );
}

function verifyJwt(token, { secret, issuer, audience }) {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience,
  });
}

function randomToken(size = 48) {
  return crypto.randomBytes(size).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function expiryDate(secondsFromNow) {
  return new Date(Date.now() + secondsFromNow * 1000);
}

module.exports = {
  nowSeconds,
  signAccessToken,
  verifyJwt,
  randomToken,
  hashToken,
  expiryDate,
};
