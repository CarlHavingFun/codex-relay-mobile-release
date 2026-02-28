const { readText, sha1 } = require('./common');

const TASK_RE = /^\s*-\s*\[\s*\]\s*\[(AUTO|GATE)\]\s+(.+)$/i;

function parsePlan(planRaw) {
  const lines = planRaw.split(/\r?\n/);
  const tasks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(TASK_RE);
    if (!m) continue;
    const mode = m[1].toUpperCase();
    const text = m[2].trim();
    const lineNo = i + 1;
    const fingerprint = sha1(`${lineNo}:${text}`);
    tasks.push({
      id: `plan_${fingerprint.slice(0, 12)}`,
      lineNo,
      mode,
      text,
      fingerprint,
      raw: line,
    });
  }
  return tasks;
}

function loadTasksFromPlan(planFile) {
  const raw = readText(planFile, '');
  return parsePlan(raw);
}

module.exports = {
  loadTasksFromPlan,
};
