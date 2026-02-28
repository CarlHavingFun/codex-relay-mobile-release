const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSessionNotLoadedCode,
  isSessionNotLoadedText,
  isRecoverableResumeError,
} = require('../lib/session_errors');

test('isSessionNotLoadedCode matches expected codes', () => {
  assert.equal(isSessionNotLoadedCode('SESSION_NOT_LOADED'), true);
  assert.equal(isSessionNotLoadedCode('thread_not_found'), true);
  assert.equal(isSessionNotLoadedCode('JOB_EXECUTION_FAILED'), false);
});

test('isSessionNotLoadedText detects rollout/session missing messages', () => {
  assert.equal(isSessionNotLoadedText('app-server thread/resume failed: No rollout found for thread id abc'), true);
  assert.equal(isSessionNotLoadedText('session not loaded on desktop'), true);
  assert.equal(isSessionNotLoadedText('timeout waiting for child process'), false);
});

test('isRecoverableResumeError only returns true for resume missing-session failures', () => {
  assert.equal(
    isRecoverableResumeError({
      method: 'thread/resume',
      message: 'app-server thread/resume failed: no rollout found for thread id 123',
    }),
    true,
  );
  assert.equal(
    isRecoverableResumeError({
      method: 'thread/resume',
      message: 'app-server thread/resume failed: error deriving config: No such file or directory (os error 2)',
    }),
    true,
  );
  assert.equal(
    isRecoverableResumeError({
      method: 'turn/start',
      message: 'thread not found',
    }),
    false,
  );
});
