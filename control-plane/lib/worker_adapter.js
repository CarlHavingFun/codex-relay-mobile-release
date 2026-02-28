// Adapter placeholder: in this phase workers claim jobs from control-plane directly.
// Keeping this file isolates future integrations (Relay command-bus, remote runners).

function workerPayloadForJob(job) {
  return {
    job_id: job.job_id,
    task_id: job.task_id,
    role: job.role,
    payload: job.payload,
    timeout_s: job.timeout_s,
    max_retries: job.max_retries,
    attempt: job.attempt,
    depends_on: job.depends_on,
  };
}

module.exports = {
  workerPayloadForJob,
};
