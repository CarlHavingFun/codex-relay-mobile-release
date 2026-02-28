#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const OUT_FILE = path.join(STATE_DIR, "platform_login_chrome_keepalive.json");

const PLATFORMS = [
  { id: "wechat_official", url: "https://mp.weixin.qq.com/", hostKey: "mp.weixin.qq.com" },
  { id: "bilibili", url: "https://passport.bilibili.com/login", hostKey: "bilibili.com" },
  { id: "weibo", url: "https://weibo.com/", hostKey: "weibo.com" },
  { id: "zhihu", url: "https://www.zhihu.com/", hostKey: "zhihu.com" },
  {
    id: "douyin",
    url: "https://creator.douyin.com/creator-micro/content/post/create",
    hostKey: "douyin.com",
  },
  { id: "kuaishou", url: "https://cp.kuaishou.com/article/publish/video", hostKey: "kuaishou.com" },
  { id: "video_channel", url: "https://channels.weixin.qq.com/platform", hostKey: "channels.weixin.qq.com" },
  { id: "jike", url: "https://web.okjike.com/", hostKey: "okjike.com" },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { intervalMin: 25, forever: false, rounds: 1, only: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--interval-min") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.intervalMin = Math.floor(raw);
      i += 1;
    } else if (arg === "--rounds") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.rounds = Math.floor(raw);
      i += 1;
    } else if (arg === "--forever") {
      out.forever = true;
    } else if (arg === "--only") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.only = raw.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escAppleScriptString(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script) {
  return execFileSync("osascript", ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function touchOne(platform) {
  const script = `tell application "Google Chrome"
if it is not running then return "ERR|chrome_not_running"
if (count of windows) = 0 then return "ERR|chrome_no_window"
set foundTab to missing value
repeat with w in windows
  repeat with t in tabs of w
    try
      set u to URL of t
    on error
      set u to ""
    end try
    if u contains "${escAppleScriptString(platform.hostKey)}" then
      set foundTab to t
      exit repeat
    end if
  end repeat
  if foundTab is not missing value then exit repeat
end repeat
if foundTab is missing value then
  tell front window to make new tab with properties {URL:"${escAppleScriptString(platform.url)}"}
  return "opened_new|${escAppleScriptString(platform.id)}"
end if
try
  execute foundTab javascript "void(document.body && document.body.offsetHeight);"
end try
try
  reload foundTab
end try
return "touched_existing|${escAppleScriptString(platform.id)}"
end tell`;

  try {
    const raw = runAppleScript(script);
    return { id: platform.id, ok: true, action: raw || "ok" };
  } catch (err) {
    return { id: platform.id, ok: false, error: String(err?.message || err) };
  }
}

async function main() {
  const args = parseArgs();
  const selected =
    args.only.length > 0 ? PLATFORMS.filter((p) => args.only.includes(p.id)) : PLATFORMS.slice();
  if (selected.length === 0) {
    const out = { ok: false, error: "no_platform_selected", selected_ids: args.only };
    writeJson(OUT_FILE, out);
    console.log(JSON.stringify(out));
    process.exitCode = 1;
    return;
  }

  const out = {
    ok: true,
    mode: args.forever ? "forever" : "fixed_rounds",
    interval_min: args.intervalMin,
    selected_ids: selected.map((p) => p.id),
    started_at: new Date().toISOString(),
    rounds: [],
  };

  let stop = false;
  const stopHandler = () => {
    stop = true;
  };
  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  let roundNo = 1;
  while (!stop) {
    const round = {
      round: roundNo,
      started_at: new Date().toISOString(),
      touched: selected.map((p) => touchOne(p)),
      finished_at: new Date().toISOString(),
    };
    out.rounds.push(round);
    out.last_round = round;
    out.finished_at = new Date().toISOString();
    writeJson(OUT_FILE, out);
    const okCount = round.touched.filter((x) => x.ok).length;
    console.log(`[chrome-keepalive] round=${roundNo} ok=${okCount}/${round.touched.length}`);

    if (!args.forever && roundNo >= args.rounds) break;
    roundNo += 1;
    if (stop) break;
    await sleep(args.intervalMin * 60 * 1000);
  }

  out.finished_at = new Date().toISOString();
  writeJson(OUT_FILE, out);
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  const out = { ok: false, error: String(err?.message || err) };
  writeJson(OUT_FILE, out);
  console.log(JSON.stringify(out));
  process.exitCode = 1;
});
