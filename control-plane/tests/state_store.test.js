const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/state_store');
const { buildExecutionPlan } = require('../lib/planner');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-test-'));
  const dbPath = path.join(dir, 'control_plane.db');
  const store = new StateStore({
    dbPath,
    globalParallelism: 10,
    defaultTaskParallelism: 8,
    circuitThreshold: 3,
  });
  return { store, dir, dbPath };
}

test('task planning -> dispatch -> worker result -> auto rollback on release failure', () => {
  const { store } = makeStore();

  const created = store.createTask({
    goal: 'Implement and deploy feature',
    repo: '/repo/path',
    branch: 'main',
    acceptance_criteria: ['build passes', 'deploy succeeds'],
    priority: 'P0',
    risk_profile: 'high',
  });

  const plan = buildExecutionPlan(created, { parallelismLimit: 8 });
  store.attachPlan(created.task_id, plan, 'unit_test_plan');

  let task = store.getTask(created.task_id);
  assert.equal(task.status, 'running');
  assert.equal(task.dag_progress.queued, 1);
  assert.equal(task.dag_progress.blocked, 3);

  const runOne = (resultStatus = 'completed', workerId = 'worker_a') => {
    const dispatchable = store.getDispatchableJobs(10);
    assert.ok(dispatchable.length >= 1);
    const targetJob = dispatchable[0];

    const dispatched = store.dispatchJobs([targetJob.job_id], 'test_dispatcher');
    assert.equal(dispatched, 1);

    const claimed = store.claimDispatchedJobs(workerId, 1);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].job_id, targetJob.job_id);

    const outcome = store.applyWorkerResult({
      worker_id: workerId,
      job_id: claimed[0].job_id,
      status: resultStatus,
      logs: [{ line: `${claimed[0].node_id}:${resultStatus}` }],
    });
    store.unblockReadyJobs(created.task_id);
    return outcome;
  };

  runOne('completed'); // coding
  runOne('completed'); // testing
  runOne('completed'); // reviewing

  task = store.getTask(created.task_id);
  assert.equal(task.status, 'releasing');

  // release first failure -> retry queued
  let releaseResult = runOne('failed');
  assert.equal(releaseResult.job.status, 'queued');

  // release second failure -> terminal and auto rollback
  releaseResult = store.applyWorkerResult({
    worker_id: 'worker_a',
    job_id: releaseResult.job.job_id,
    status: 'failed',
    logs: [{ line: 'release:failed-final' }],
  });
  task = store.getTask(created.task_id);

  assert.equal(task.status, 'rolled_back');
  assert.equal(task.degraded, true);
  assert.ok(task.rollbacks.length >= 1);
  assert.equal(releaseResult.task.status, 'rolled_back');

  const circuit = store.getCircuit();
  assert.equal(circuit.status, 'closed');
  assert.equal(Number(circuit.failure_count), 1);
});

test('emergency stop blocks new dispatch', () => {
  const { store } = makeStore();
  const created = store.createTask({
    goal: 'Do work',
    repo: '/repo/path',
    branch: 'main',
  });
  const plan = buildExecutionPlan(created, { parallelismLimit: 8 });
  store.attachPlan(created.task_id, plan, 'unit_test_plan');

  const before = store.getDispatchableJobs(10);
  assert.ok(before.length >= 1);

  store.setEmergencyStop(true, 'test', 'halt all');
  const after = store.getDispatchableJobs(10);
  assert.equal(after.length, 0);
});
