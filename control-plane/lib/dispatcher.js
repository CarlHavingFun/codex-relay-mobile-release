async function processControlPlaneTick({
  store,
  buildExecutionPlan,
  decideDispatchLimit,
  dispatcherId = 'control-plane-dispatcher',
  planningBatch = 10,
  dispatchUpperBound = 10,
}) {
  const planningCandidates = store.listPlanningCandidates(planningBatch);
  let planned = 0;
  for (const task of planningCandidates) {
    const plan = buildExecutionPlan(task, {
      parallelismLimit: task.parallelism_limit,
    });
    store.attachPlan(task.task_id, plan, 'planner_tick');
    planned += 1;
  }

  const tasks = store.listTasks(300);
  const activeTasks = tasks.filter((task) => ['running', 'reviewing', 'releasing', 'planning'].includes(task.status));
  let unblocked = 0;
  for (const task of activeTasks) {
    unblocked += store.unblockReadyJobs(task.task_id);
  }

  const queueDepth = tasks
    .map((task) => store.getTask(task.task_id))
    .reduce((acc, task) => acc + Number(task?.dag_progress?.queued || 0), 0);

  const snapshot = store.systemSnapshot();
  const dynamicLimit = decideDispatchLimit({
    ...snapshot,
    queue_depth: queueDepth,
  }, {
    maxParallelism: dispatchUpperBound,
  });

  let dispatched = 0;
  if (dynamicLimit > 0) {
    const dispatchableJobs = store.getDispatchableJobs(dynamicLimit);
    if (dispatchableJobs.length) {
      dispatched = store.dispatchJobs(dispatchableJobs.map((job) => job.job_id), dispatcherId);
    }
  }

  return {
    planned,
    unblocked,
    dispatched,
    queue_depth: queueDepth,
    dispatch_limit: dynamicLimit,
    snapshot,
  };
}

module.exports = {
  processControlPlaneTick,
};
