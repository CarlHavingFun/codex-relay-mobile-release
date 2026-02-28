function normalizeErrorText(value) {
  return String(value || '').trim().toLowerCase();
}

const SESSION_NOT_LOADED_CODES = new Set([
  'session_not_loaded',
  'session_not_found',
  'thread_not_found',
  'thread_not_loaded',
]);

function isSessionNotLoadedCode(value) {
  const code = normalizeErrorText(value).replace(/\./g, '_');
  return SESSION_NOT_LOADED_CODES.has(code);
}

function isSessionNotLoadedText(value) {
  const message = normalizeErrorText(value);
  if (!message) return false;
  return (
    message.includes('session not loaded') ||
    message.includes('session_not_loaded') ||
    message.includes('session not found') ||
    message.includes('session_not_found') ||
    message.includes('thread not found') ||
    message.includes('thread_not_found') ||
    message.includes('no rollout found for thread id') ||
    message.includes('no archived rollout found') ||
    message.includes('rollout not found') ||
    message.includes('missing rollout')
  );
}

function isRecoverableResumeConfigErrorText(value) {
  const message = normalizeErrorText(value);
  if (!message) return false;
  if (!message.includes('error deriving config')) return false;
  return (
    message.includes('no such file or directory') ||
    message.includes('os error 2')
  );
}

function isRecoverableResumeError(err) {
  const method = normalizeErrorText(err?.method);
  const message = normalizeErrorText(err?.message || err);
  const resumeError = method === 'thread/resume' || message.includes('thread/resume');
  if (!resumeError) return false;
  return (
    isSessionNotLoadedCode(err?.code) ||
    isSessionNotLoadedText(message) ||
    isRecoverableResumeConfigErrorText(message)
  );
}

module.exports = {
  isSessionNotLoadedCode,
  isSessionNotLoadedText,
  isRecoverableResumeError,
};
