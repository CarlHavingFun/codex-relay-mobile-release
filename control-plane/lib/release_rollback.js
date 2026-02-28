function rollbackDescriptor(task, reason) {
  return {
    task_id: task.task_id,
    repo: task.repo,
    branch: task.branch,
    reason,
    mode: 'auto',
  };
}

module.exports = {
  rollbackDescriptor,
};
