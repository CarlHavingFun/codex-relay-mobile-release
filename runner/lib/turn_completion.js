const { isSessionNotLoadedCode, isSessionNotLoadedText } = require('./session_errors');

function normalizeTurnFinalStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return 'failed';
  return status;
}

function extractTurnErrorInfo(params) {
  const root = params && typeof params === 'object' ? params : {};
  const turn = root.turn && typeof root.turn === 'object' ? root.turn : {};
  const turnError = turn.error && typeof turn.error === 'object' ? turn.error : {};
  const rootError = root.error && typeof root.error === 'object' ? root.error : {};

  const code = String(
    turnError.code ||
    turnError.error_code ||
    rootError.code ||
    rootError.error_code ||
    root.error_code ||
    '',
  ).trim();
  const message = String(
    turnError.message ||
    rootError.message ||
    root.error_message ||
    '',
  ).trim();

  return { code, message };
}

function relayCompletionForTurnStatus(statusValue, params = null) {
  const status = normalizeTurnFinalStatus(statusValue);
  const turnError = extractTurnErrorInfo(params);
  const sessionNotLoaded = isSessionNotLoadedCode(turnError.code)
    || isSessionNotLoadedText(turnError.message)
    || ['notloaded', 'not_loaded', 'session_not_loaded', 'session_not_found'].includes(status);

  if (status === 'completed') {
    return {
      relayStatus: 'completed',
      errorCode: null,
      errorMessage: null,
      logLabel: 'completed',
    };
  }

  if (sessionNotLoaded) {
    return {
      relayStatus: 'failed',
      errorCode: 'SESSION_NOT_LOADED',
      errorMessage: turnError.message || `turn finished with status=${status}`,
      logLabel: 'session_not_loaded',
    };
  }

  if (['interrupted', 'cancelled', 'canceled', 'aborted', 'stopped'].includes(status)) {
    return {
      relayStatus: 'interrupted',
      errorCode: 'TURN_INTERRUPTED',
      errorMessage: turnError.message || `turn finished with status=${status}`,
      logLabel: 'interrupted',
    };
  }

  if (status === 'timed_out' || status === 'timeout') {
    return {
      relayStatus: 'timeout',
      errorCode: 'TURN_TIMEOUT',
      errorMessage: turnError.message || `turn finished with status=${status}`,
      logLabel: 'timeout',
    };
  }

  return {
    relayStatus: 'failed',
    errorCode: isSessionNotLoadedCode(turnError.code) ? 'SESSION_NOT_LOADED' : 'TURN_NOT_COMPLETED',
    errorMessage: turnError.message || `turn finished with status=${status}`,
    logLabel: 'failed',
  };
}

module.exports = {
  relayCompletionForTurnStatus,
  normalizeTurnFinalStatus,
  extractTurnErrorInfo,
};
