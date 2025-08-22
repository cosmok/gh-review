const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;

function structuredLog(severity, message, fields = {}) {
  const normalized = severity.toLowerCase();
  const levelKey = normalized === 'warning' ? 'warn' : normalized;
  const severityLevel = LOG_LEVELS[levelKey] ?? LOG_LEVELS.info;
  if (severityLevel > CURRENT_LOG_LEVEL) return;
  const logData = JSON.stringify({ severity: levelKey, message, ...fields, timestamp: new Date().toISOString() });
  switch (levelKey) {
    case 'error':
      console.error(logData);
      break;
    case 'warn':
      console.warn(logData);
      break;
    case 'info':
      console.info(logData);
      break;
    case 'debug':
      console.debug(logData);
      break;
    default:
      console.log(logData);
  }
}

module.exports = { structuredLog };
