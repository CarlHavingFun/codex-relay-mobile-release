#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state');
const PORT = Number(process.env.DASHBOARD_PORT || 8788);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readEvents(limit = 200) {
  const f = path.join(STATE_DIR, 'events.ndjson');
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const file = path.join(__dirname, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const status = readJSON(path.join(STATE_DIR, 'runner_state.json'), {});
    const progress = readJSON(path.join(STATE_DIR, 'plan_progress.json'), { completed: {}, failed: {}, rejected: {} });
    json(res, 200, {
      ok: true,
      status,
      progress_summary: {
        completed: Object.keys(progress.completed || {}).length,
        failed: Object.keys(progress.failed || {}).length,
        rejected: Object.keys(progress.rejected || {}).length,
      },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    const approvals = readJSON(path.join(STATE_DIR, 'approvals.json'), []);
    json(res, 200, { ok: true, approvals: approvals.slice(-200).reverse() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 300)));
    json(res, 200, { ok: true, events: readEvents(limit) });
    return;
  }

  json(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[dashboard] http://127.0.0.1:${PORT}`);
});
