const { clampInt } = require('./common');

function buildExecutionPlan(taskSpec, opts = {}) {
  const parallelismLimit = clampInt(
    taskSpec.parallelism_limit,
    1,
    10,
    clampInt(opts.parallelismLimit, 1, 10, 8),
  );

  const basePayload = {
    goal: taskSpec.goal,
    repo: taskSpec.repo,
    branch: taskSpec.branch,
    acceptance_criteria: Array.isArray(taskSpec.acceptance_criteria)
      ? taskSpec.acceptance_criteria
      : [],
    priority: taskSpec.priority,
    risk_profile: taskSpec.risk_profile,
  };

  const nodes = [
    {
      node_id: 'coding',
      role: 'coder',
      timeout_s: 45 * 60,
      max_retries: 2,
      depends_on: [],
      payload: { ...basePayload, stage: 'coding' },
    },
    {
      node_id: 'testing',
      role: 'tester',
      timeout_s: 30 * 60,
      max_retries: 2,
      depends_on: ['coding'],
      payload: { ...basePayload, stage: 'testing' },
    },
    {
      node_id: 'reviewing',
      role: 'reviewer',
      timeout_s: 20 * 60,
      max_retries: 1,
      depends_on: ['testing'],
      payload: { ...basePayload, stage: 'reviewing' },
    },
    {
      node_id: 'releasing',
      role: 'release',
      timeout_s: 20 * 60,
      max_retries: 1,
      depends_on: ['reviewing'],
      payload: { ...basePayload, stage: 'releasing' },
    },
  ];

  const edges = [
    { from: 'coding', to: 'testing' },
    { from: 'testing', to: 'reviewing' },
    { from: 'reviewing', to: 'releasing' },
  ];

  return {
    parallelism_limit: parallelismLimit,
    nodes,
    edges,
  };
}

module.exports = {
  buildExecutionPlan,
};
