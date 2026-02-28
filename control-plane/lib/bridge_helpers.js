const path = require('node:path');

function workspaceFromRepo(repo, fallback = 'default') {
  const value = String(repo || '').trim();
  if (!value) return String(fallback || 'default');
  const normalized = value
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[?#].*$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  if (!segments.length) return String(fallback || 'default');
  const tail = segments[segments.length - 1];
  const base = path.basename(tail).trim();
  return base || String(fallback || 'default');
}

function roleInstruction(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'tester') {
    return [
      '- Focus on verification and regression checks for this node.',
      '- Run tests and report pass/fail with key evidence.',
      '- If checks fail, include exact failure reason and minimal repro hints.',
    ];
  }
  if (normalized === 'reviewer') {
    return [
      '- Perform a code-review style pass focused on bugs, regressions, and risks.',
      '- Prioritize concrete findings by severity with file-level references when possible.',
      '- If no findings, explicitly state that and list residual risks/test gaps.',
    ];
  }
  if (normalized === 'release') {
    return [
      '- Prepare release/deploy execution for this node and verify rollout safety.',
      '- If publish/deploy fails, provide rollback recommendation and impacted scope.',
      '- Report final release status with rollback readiness assessment.',
    ];
  }
  return [
    '- Implement the required changes end-to-end for this node.',
    '- Keep edits scoped and validate results with relevant checks.',
    '- Report what changed, why, and what was verified.',
  ];
}

function buildSubAgentPrompt(job) {
  const payload = job && typeof job.payload === 'object' ? job.payload : {};
  const goal = String(payload.goal || '').trim() || 'No explicit goal provided';
  const repo = String(payload.repo || '').trim() || 'unknown_repo';
  const branch = String(payload.branch || '').trim() || 'main';
  const stage = String(payload.stage || job.node_id || '').trim() || 'unspecified_stage';
  const criteria = Array.isArray(payload.acceptance_criteria)
    ? payload.acceptance_criteria.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const lines = [
    `Control Plane Task: ${String(job.task_id || '')}`,
    `Job ID: ${String(job.job_id || '')}`,
    `Node: ${String(job.node_id || '')}`,
    `Role: ${String(job.role || '')}`,
    `Stage: ${stage}`,
    `Repository: ${repo}`,
    `Branch: ${branch}`,
    '',
    'Objective:',
    goal,
    '',
    'Acceptance Criteria:',
  ];

  if (!criteria.length) {
    lines.push('- No explicit acceptance criteria provided; infer safe, verifiable checks.');
  } else {
    for (const item of criteria) lines.push(`- ${item}`);
  }

  lines.push('', 'Execution Requirements:');
  for (const item of roleInstruction(job.role)) lines.push(item);

  lines.push(
    '',
    'Output Requirements:',
    '- Give a concise execution summary.',
    '- List checks run and their outcomes.',
    '- If blocked or failed, include concrete blocker/error details.',
  );

  return lines.join('\n');
}

function mapRelayStatusToWorkerStatus(relayStatus) {
  const normalized = String(relayStatus || '').trim().toLowerCase();
  if (normalized === 'completed') {
    return { workerStatus: 'completed', terminal: true };
  }
  if (normalized === 'timeout' || normalized === 'timed_out') {
    return { workerStatus: 'timeout', terminal: true };
  }
  if (['interrupted', 'canceled', 'cancelled', 'aborted', 'stopped'].includes(normalized)) {
    return { workerStatus: 'canceled', terminal: true };
  }
  if (normalized === 'failed') {
    return { workerStatus: 'failed', terminal: true };
  }
  if (['queued', 'claimed', 'running'].includes(normalized)) {
    return { workerStatus: normalized, terminal: false };
  }
  return { workerStatus: 'failed', terminal: true };
}

module.exports = {
  workspaceFromRepo,
  buildSubAgentPrompt,
  mapRelayStatusToWorkerStatus,
};
