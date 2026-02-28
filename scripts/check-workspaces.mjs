#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const PROFILE_DIR = path.join(STATE_DIR, "chatgpt-profile");
const PROFILES_FILE = path.join(STATE_DIR, "auth_profiles.json");
const PROFILE_STATE_FILE = path.join(STATE_DIR, "auth_profile_state.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeProfiles(raw) {
  const inProfiles = Array.isArray(raw) ? raw : [];
  const profiles = [];
  for (const item of inProfiles) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    if (!id) continue;
    const enabled = item.enabled !== false;
    const priority = Number.isFinite(Number(item.priority)) ? Math.floor(Number(item.priority)) : 100;
    const codexHomeRaw = String(item.codex_home || "").trim();
    const codexHome = codexHomeRaw
      ? codexHomeRaw.replace(/^~\//, `${os.homedir()}/`)
      : path.join(os.homedir(), ".codex");
    profiles.push({
      id,
      name: String(item.name || id).trim() || id,
      codex_home: codexHome,
      workspace_hint: String(item.workspace_hint || "*").trim() || "*",
      priority,
      enabled,
    });
  }
  if (!profiles.length) {
    profiles.push({
      id: "primary",
      name: "Primary",
      codex_home: path.join(os.homedir(), ".codex"),
      workspace_hint: "*",
      priority: 100,
      enabled: true,
    });
  }
  profiles.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return profiles;
}

function loadProfiles() {
  const parsed = readJson(PROFILES_FILE, null);
  const profiles = normalizeProfiles(parsed);
  if (!Array.isArray(parsed) || !parsed.length) {
    writeJson(PROFILES_FILE, profiles);
  }
  return profiles;
}

function loadProfileState() {
  return readJson(PROFILE_STATE_FILE, {
    active_profile_id: null,
    last_switch_at: null,
    consecutive_failures: 0,
    last_error: null,
    probes: {},
  });
}

function saveProfileState(state) {
  writeJson(PROFILE_STATE_FILE, state);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    mode: "probe",
    profileId: null,
    headful: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--probe") out.mode = "probe";
    else if (arg === "--switch") {
      out.mode = "switch";
      out.profileId = String(args[i + 1] || "").trim() || null;
      i += 1;
    } else if (arg === "--ensure-login") out.mode = "ensure-login";
    else if (arg === "--login") out.mode = "login";
    else if (arg === "--profile") {
      out.profileId = String(args[i + 1] || "").trim() || null;
      i += 1;
    } else if (arg === "--headful") out.headful = true;
  }
  return out;
}

async function withPlaywright(fn) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (err) {
    return {
      ok: false,
      error: `playwright_not_installed: ${String(err?.message || err)}`,
    };
  }
  return fn(playwright);
}

async function probeBrowserSession() {
  ensureDir(PROFILE_DIR);
  return withPlaywright(async (playwright) => {
    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto("https://chat.openai.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(1500);
      const url = page.url();
      const markers = await page.evaluate(() => {
        const text = (document.body?.innerText || "").toLowerCase();
        const hasLogin = text.includes("log in") || text.includes("sign up");
        const hasComposer =
          !!document.querySelector("textarea") ||
          !!document.querySelector("[contenteditable='true']") ||
          text.includes("message chatgpt");
        return {
          hasLogin,
          hasComposer,
          title: document.title,
        };
      });
      const authenticated = markers.hasComposer && !markers.hasLogin;
      return {
        ok: true,
        authenticated,
        needs_login: !authenticated,
        url,
        title: markers.title,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err),
      };
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

async function openLoginWindow() {
  ensureDir(PROFILE_DIR);
  return withPlaywright(async (playwright) => {
    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto("https://chat.openai.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const started = Date.now();
      while (Date.now() - started < 180000) {
        await page.waitForTimeout(2000);
      }
      return { ok: true, note: "login_window_closed_after_180s" };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err),
      };
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

function pickProfile(profiles, explicitProfileId, state) {
  if (explicitProfileId) {
    return profiles.find((item) => item.id === explicitProfileId) || null;
  }
  if (state.active_profile_id) {
    return profiles.find((item) => item.id === state.active_profile_id) || null;
  }
  return profiles[0] || null;
}

async function main() {
  const args = parseArgs();
  const profiles = loadProfiles();
  const state = loadProfileState();
  const selected = pickProfile(profiles, args.profileId, state);
  if (!selected) {
    console.log(JSON.stringify({ ok: false, error: "no_profile_available" }));
    process.exitCode = 1;
    return;
  }

  if (args.mode === "switch") {
    state.active_profile_id = selected.id;
    state.last_switch_at = nowIso();
    state.last_error = null;
    saveProfileState(state);
    console.log(
      JSON.stringify({
        ok: true,
        mode: "switch",
        active_profile_id: selected.id,
        profile: selected,
      }),
    );
    return;
  }

  if (args.mode === "login") {
    const loginResult = await openLoginWindow();
    console.log(
      JSON.stringify({
        ok: !!loginResult.ok,
        mode: "login",
        profile: selected,
        profile_dir: PROFILE_DIR,
        ...loginResult,
      }),
    );
    if (!loginResult.ok) process.exitCode = 1;
    return;
  }

  const probe = await probeBrowserSession();
  const nextState = {
    ...state,
    active_profile_id: selected.id,
    probes: {
      ...(state.probes && typeof state.probes === "object" ? state.probes : {}),
      [selected.id]: {
        at: nowIso(),
        ok: !!probe.ok,
        authenticated: !!probe.authenticated,
        message: probe.error || null,
      },
    },
  };
  saveProfileState(nextState);

  if (args.mode === "ensure-login" && probe.ok && !probe.authenticated) {
    console.log(
      JSON.stringify({
        ok: false,
        mode: "ensure-login",
        profile: selected,
        profile_dir: PROFILE_DIR,
        needs_login: true,
        action: "run: node scripts/check-workspaces.mjs --login",
      }),
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    JSON.stringify({
      ok: !!probe.ok,
      mode: args.mode,
      profile: selected,
      profile_dir: PROFILE_DIR,
      ...probe,
    }),
  );
  if (!probe.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exitCode = 1;
});
