const { addSeconds } = require('./common');

function isCriticalRole(role) {
  const r = String(role || '').toLowerCase();
  return r === 'reviewer' || r === 'release';
}

function isHighRiskJob(job) {
  return String(job?.role || '').toLowerCase() === 'release';
}

function retryBackoffSeconds(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(300, 5 * (2 ** (n - 1)));
}

function nextRunAtFromAttempt(nowIso, attempt) {
  return addSeconds(nowIso, retryBackoffSeconds(attempt));
}

function canDispatchHighRisk(task, circuit, emergencyStopActive) {
  if (emergencyStopActive) return false;
  if (String(circuit?.status || '').toLowerCase() === 'open') return false;

  let metadata = {};
  try {
    metadata = task.metadata || {};
  } catch {
    metadata = {};
  }
  const rollbackAvailable = metadata.rollback_available !== false;
  return rollbackAvailable;
}

module.exports = {
  isCriticalRole,
  isHighRiskJob,
  retryBackoffSeconds,
  nextRunAtFromAttempt,
  canDispatchHighRisk,
};
