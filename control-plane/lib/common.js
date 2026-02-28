const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = 'id') {
  const suffix = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(8).toString('hex');
  return `${prefix}_${suffix}`;
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function addSeconds(iso, seconds) {
  const baseMs = Date.parse(iso || nowIso());
  const ms = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(ms + (Math.max(0, Number(seconds) || 0) * 1000)).toISOString();
}

module.exports = {
  nowIso,
  randomId,
  parseJson,
  clampInt,
  parseBool,
  addSeconds,
};
