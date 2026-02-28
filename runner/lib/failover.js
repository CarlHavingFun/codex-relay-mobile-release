const path = require("node:path");
const os = require("node:os");
const { readJSON } = require("./common");

function normalizeProfiles(rawProfiles) {
  const rows = Array.isArray(rawProfiles) ? rawProfiles : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || "").trim();
    if (!id) continue;
    const priority = Number.isFinite(Number(row.priority)) ? Math.floor(Number(row.priority)) : 100;
    const codexHomeRaw = String(row.codex_home || "").trim();
    const codexHome = codexHomeRaw
      ? codexHomeRaw.replace(/^~\//, `${os.homedir()}/`)
      : path.join(os.homedir(), ".codex");
    out.push({
      id,
      name: String(row.name || id).trim() || id,
      codex_home: codexHome,
      workspace_hint: String(row.workspace_hint || "*").trim() || "*",
      priority,
      enabled: row.enabled !== false,
    });
  }
  if (!out.length) {
    out.push({
      id: "primary",
      name: "Primary",
      codex_home: path.join(os.homedir(), ".codex"),
      workspace_hint: "*",
      priority: 100,
      enabled: true,
    });
  }
  out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return out;
}

function loadAuthProfiles(file) {
  const raw = readJSON(file, null);
  return normalizeProfiles(raw);
}

function loadFailoverState(file) {
  return readJSON(file, {
    active_profile_id: null,
    last_switch_at: null,
    consecutive_failures: 0,
    last_error: null,
  });
}

function nextProfile(profiles, activeProfileId) {
  const enabled = profiles.filter((row) => row.enabled);
  if (!enabled.length) return null;
  if (!activeProfileId) return enabled[0];
  const idx = enabled.findIndex((row) => row.id === activeProfileId);
  if (idx === -1) return enabled[0];
  return enabled[(idx + 1) % enabled.length];
}

function profileById(profiles, profileId) {
  return profiles.find((row) => row.id === profileId) || null;
}

function isEveryProfileExhausted(profiles, attempts) {
  const enabled = profiles.filter((row) => row.enabled).map((row) => row.id);
  if (!enabled.length) return true;
  const used = new Set(Array.isArray(attempts) ? attempts : []);
  for (const id of enabled) {
    if (!used.has(id)) return false;
  }
  return true;
}

module.exports = {
  normalizeProfiles,
  loadAuthProfiles,
  loadFailoverState,
  nextProfile,
  profileById,
  isEveryProfileExhausted,
};
