const { clampInt } = require('./common');

function decideDispatchLimit(snapshot, opts = {}) {
  const configuredMax = clampInt(opts.maxParallelism, 1, 20, 10);
  const queueDepth = Number(snapshot?.queue_depth || 0);
  const active = Number(snapshot?.global_active_jobs || 0);
  const circuitStatus = String(snapshot?.circuit_breaker?.status || 'closed').toLowerCase();
  const emergencyStop = !!snapshot?.emergency_stop?.active;

  if (emergencyStop || circuitStatus === 'open') return 0;

  if (queueDepth >= configuredMax) return configuredMax;
  if (queueDepth >= 4) return Math.min(configuredMax, Math.max(4, queueDepth));

  // Keep a small floor for progress but avoid hot-loop churn.
  const idleBoost = active === 0 ? 2 : 1;
  return Math.min(configuredMax, Math.max(1, queueDepth + idleBoost));
}

module.exports = {
  decideDispatchLimit,
};
