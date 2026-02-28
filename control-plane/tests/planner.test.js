const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExecutionPlan } = require('../lib/planner');

test('buildExecutionPlan returns deterministic 4-stage DAG', () => {
  const plan = buildExecutionPlan({
    goal: 'Ship feature X',
    repo: 'github.com/acme/repo',
    branch: 'feature/x',
    acceptance_criteria: ['tests pass'],
    priority: 'P1',
    risk_profile: 'high',
    parallelism_limit: 9,
  }, {
    parallelismLimit: 8,
  });

  assert.equal(plan.parallelism_limit, 9);
  assert.equal(plan.nodes.length, 4);
  assert.deepEqual(plan.nodes.map((node) => node.node_id), ['coding', 'testing', 'reviewing', 'releasing']);
  assert.equal(plan.nodes[3].role, 'release');
  assert.deepEqual(plan.edges, [
    { from: 'coding', to: 'testing' },
    { from: 'testing', to: 'reviewing' },
    { from: 'reviewing', to: 'releasing' },
  ]);
});
