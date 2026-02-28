const test = require('node:test');
const assert = require('node:assert/strict');
const {
  workspaceFromRepo,
  buildSubAgentPrompt,
  mapRelayStatusToWorkerStatus,
} = require('../lib/bridge_helpers');

test('workspaceFromRepo handles local and remote repo forms', () => {
  assert.equal(workspaceFromRepo('/tmp/codex_iphone', 'fallback'), 'codex_iphone');
  assert.equal(workspaceFromRepo('https://github.com/openai/codex.git', 'fallback'), 'codex');
  assert.equal(workspaceFromRepo('', 'fallback'), 'fallback');
});

test('buildSubAgentPrompt includes task, node, role, and criteria', () => {
  const prompt = buildSubAgentPrompt({
    task_id: 'task_123',
    job_id: 'job_123',
    node_id: 'testing',
    role: 'tester',
    payload: {
      goal: 'Ship feature X',
      repo: '/repo/path',
      branch: 'main',
      stage: 'testing',
      acceptance_criteria: ['unit tests pass', 'no regression'],
    },
  });
  assert.match(prompt, /Control Plane Task: task_123/);
  assert.match(prompt, /Role: tester/);
  assert.match(prompt, /- unit tests pass/);
  assert.match(prompt, /Execution Requirements:/);
});

test('mapRelayStatusToWorkerStatus maps terminal and non-terminal states', () => {
  assert.deepEqual(mapRelayStatusToWorkerStatus('completed'), { workerStatus: 'completed', terminal: true });
  assert.deepEqual(mapRelayStatusToWorkerStatus('running'), { workerStatus: 'running', terminal: false });
  assert.deepEqual(mapRelayStatusToWorkerStatus('timeout'), { workerStatus: 'timeout', terminal: true });
  assert.deepEqual(mapRelayStatusToWorkerStatus('interrupted'), { workerStatus: 'canceled', terminal: true });
});
