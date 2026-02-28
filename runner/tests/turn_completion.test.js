const test = require('node:test');
const assert = require('node:assert/strict');
const { relayCompletionForTurnStatus } = require('../lib/turn_completion');

test('completed status maps to relay completed', () => {
  const result = relayCompletionForTurnStatus('completed');
  assert.deepEqual(result, {
    relayStatus: 'completed',
    errorCode: null,
    errorMessage: null,
    logLabel: 'completed',
  });
});

test('session-not-loaded errors map to SESSION_NOT_LOADED', () => {
  const result = relayCompletionForTurnStatus('failed', {
    turn: {
      status: 'failed',
      error: {
        code: 'session_not_found',
        message: 'session not found',
      },
    },
  });
  assert.equal(result.relayStatus, 'failed');
  assert.equal(result.errorCode, 'SESSION_NOT_LOADED');
});

test('notloaded status maps to SESSION_NOT_LOADED even without error payload', () => {
  const result = relayCompletionForTurnStatus('notloaded');
  assert.equal(result.relayStatus, 'failed');
  assert.equal(result.errorCode, 'SESSION_NOT_LOADED');
});

test('timeout status maps to relay timeout', () => {
  const result = relayCompletionForTurnStatus('timed_out');
  assert.equal(result.relayStatus, 'timeout');
  assert.equal(result.errorCode, 'TURN_TIMEOUT');
});
