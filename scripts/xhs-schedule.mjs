#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const NOTE_FILE_MEMO = path.join(ROOT, "output", "小红书_明日发布文案_备忘录.txt");
const NOTE_FILE_LEGACY = path.join(ROOT, "output", "小红书_明日发布文案_记事本.txt");
const SCHEDULE_STATE_FILE = path.join(STATE_DIR, "xhs_schedule_state.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeBeijingDateTime(raw) {
  const m = String(raw || "")
    .trim()
    .match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
}

function parseBeijingToDate(value) {
  const normalized = normalizeBeijingDateTime(value);
  if (!normalized) return null;
  const [datePart, timePart] = normalized.split(" ");
  const dt = new Date(`${datePart}T${timePart}:00+08:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function formatBeijing(ts) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ts);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function tomorrowBeijing1220() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const today = new Date(`${map.year}-${map.month}-${map.day}T00:00:00+08:00`);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return formatBeijing(new Date(tomorrow.getTime() + (12 * 60 + 20) * 60 * 1000));
}

function resolveDefaultNoteFile() {
  if (fs.existsSync(NOTE_FILE_MEMO)) return NOTE_FILE_MEMO;
  if (fs.existsSync(NOTE_FILE_LEGACY)) return NOTE_FILE_LEGACY;
  return NOTE_FILE_MEMO;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    targetBeijing: null,
    dryRun: false,
    noteFile: resolveDefaultNoteFile(),
    timeoutSec: 180,
    headless: false,
    cleanupLegacyLocal: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.targetBeijing = raw;
      i += 1;
    } else if (arg === "--note-file") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.noteFile = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i += 1;
    } else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1] || 0);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--headed") {
      out.headless = false;
    } else if (arg === "--headless") {
      out.headless = true;
    } else if (arg === "--no-cleanup-local") {
      out.cleanupLegacyLocal = false;
    }
  }
  return out;
}

function normalizeTarget(raw) {
  const normalized = normalizeBeijingDateTime(raw);
  if (normalized) return normalized;
  const dt = new Date(String(raw || "").trim());
  if (!Number.isNaN(dt.getTime())) {
    return formatBeijing(dt);
  }
  return null;
}

function cleanupLegacyLocalSchedules() {
  const launchDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const prefix = "com.yourorg.codexrelay.xhs.publish.";
  if (!fs.existsSync(launchDir)) {
    return {
      attempted: false,
      removed_plists: [],
      removed_runner_scripts: [],
    };
  }

  const uid = process.getuid();
  const plistFiles = fs
    .readdirSync(launchDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".plist"))
    .map((name) => path.join(launchDir, name));

  const removedPlists = [];
  const removedRunnerScripts = [];
  for (const plist of plistFiles) {
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plist], { stdio: "ignore" });
    } catch {}
    try {
      fs.rmSync(plist, { force: true });
      removedPlists.push(plist);
    } catch {}

    const label = path.basename(plist, ".plist");
    const runner = path.join(STATE_DIR, `${label}.sh`);
    if (fs.existsSync(runner)) {
      try {
        fs.rmSync(runner, { force: true });
        removedRunnerScripts.push(runner);
      } catch {}
    }
  }

  return {
    attempted: true,
    removed_plists: removedPlists,
    removed_runner_scripts: removedRunnerScripts,
  };
}

function parseJsonFromStdout(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runPlatformSchedulePublish({ targetBeijing, noteFile, timeoutSec, dryRun, headless }) {
  const publishScript = path.join(ROOT, "scripts", "xhs-publish.mjs");
  const argv = [
    publishScript,
    "--platform-schedule",
    "--schedule-beijing",
    targetBeijing,
    "--note-file",
    noteFile,
    "--timeout-sec",
    String(timeoutSec),
  ];
  if (dryRun) argv.push("--dry-run");
  if (!headless) argv.push("--headed");
  const child = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
  });

  const parsed = parseJsonFromStdout(child.stdout);
  return {
    status: child.status,
    signal: child.signal,
    stdout: String(child.stdout || ""),
    stderr: String(child.stderr || ""),
    parsed,
  };
}

function main() {
  const args = parseArgs();
  const targetBeijing = normalizeTarget(args.targetBeijing || tomorrowBeijing1220());
  if (!targetBeijing) throw new Error("invalid_target_time");
  const targetDate = parseBeijingToDate(targetBeijing);
  if (!targetDate) throw new Error("invalid_target_time");
  if (targetDate.getTime() <= Date.now() + 2 * 60 * 1000) {
    throw new Error("target_time_too_soon_or_in_past");
  }

  if (!fs.existsSync(args.noteFile)) {
    throw new Error(`note_file_not_found: ${args.noteFile}`);
  }

  const cleanup = args.cleanupLegacyLocal
    ? cleanupLegacyLocalSchedules()
    : {
        attempted: false,
        removed_plists: [],
        removed_runner_scripts: [],
      };
  const publish = runPlatformSchedulePublish({
    targetBeijing,
    noteFile: args.noteFile,
    timeoutSec: args.timeoutSec,
    dryRun: args.dryRun,
    headless: args.headless,
  });

  const publishResult = publish.parsed || {
    ok: false,
    error: "publish_output_not_json",
  };
  const ok = publish.status === 0 && !!publishResult.ok;
  const output = {
    ok,
    mode: "platform_schedule",
    dry_run: args.dryRun,
    target_beijing: targetBeijing,
    target_iso: targetDate.toISOString(),
    note_file: args.noteFile,
    cleanup,
    publish_exit_status: publish.status,
    publish_result: publishResult,
    created_at: nowIso(),
  };

  writeJson(SCHEDULE_STATE_FILE, output);
  console.log(JSON.stringify(output));
  if (!ok) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  const output = { ok: false, error: String(err?.message || err) };
  console.log(JSON.stringify(output));
  process.exitCode = 1;
}
