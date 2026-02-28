const path = require('node:path');
const { readJSON } = require('./common');

function loadRules(rootDir) {
  const file = path.join(rootDir, 'config', 'risk_rules.json');
  return readJSON(file, []);
}

function detectRisk(taskText, rules) {
  const reasons = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.regex, 'i');
      if (re.test(taskText)) reasons.push(rule.reason || rule.id || 'High-risk operation');
    } catch {
      // ignore invalid regex
    }
  }
  return reasons;
}

module.exports = {
  loadRules,
  detectRisk,
};
