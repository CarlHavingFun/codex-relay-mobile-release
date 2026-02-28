function summarizeTaskCounts(tasks) {
  const counts = {
    queued: 0,
    planning: 0,
    running: 0,
    reviewing: 0,
    releasing: 0,
    done: 0,
    failed: 0,
    rolled_back: 0,
    paused: 0,
    canceled: 0,
  };
  for (const task of tasks) {
    const status = String(task.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

module.exports = {
  summarizeTaskCounts,
};
