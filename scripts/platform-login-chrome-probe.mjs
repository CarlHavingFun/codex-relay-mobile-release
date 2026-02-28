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
const OUT_FILE = path.join(STATE_DIR, "platform_login_chrome_probe.json");

const PLATFORMS = [
  {
    id: "wechat_official",
    label: "微信公众号",
    url: "https://mp.weixin.qq.com/",
    hostKey: "mp.weixin.qq.com",
    hints: ["请使用微信扫描二维码登录", "扫码", "登录"],
  },
  {
    id: "bilibili",
    label: "B站",
    url: "https://passport.bilibili.com/login",
    hostKey: "bilibili.com",
    hints: ["账号登录", "短信登录", "扫码登录", "立即登录"],
  },
  {
    id: "weibo",
    label: "微博",
    url: "https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/",
    hostKey: "weibo.com",
    hints: ["登录", "注册", "手机验证码"],
  },
  {
    id: "zhihu",
    label: "知乎",
    url: "https://www.zhihu.com/signin?next=%2F",
    hostKey: "zhihu.com",
    hints: ["登录", "注册", "验证码", "手机号"],
  },
  {
    id: "douyin",
    label: "抖音",
    url: "https://creator.douyin.com/creator-micro/content/post/create",
    hostKey: "douyin.com",
    hints: ["登录", "验证码", "手机登录", "扫码登录"],
  },
  {
    id: "kuaishou",
    label: "快手",
    url: "https://cp.kuaishou.com/article/publish/video",
    hostKey: "kuaishou.com",
    hints: ["登录", "验证码", "手机号", "扫码"],
  },
  {
    id: "video_channel",
    label: "视频号",
    url: "https://channels.weixin.qq.com/platform",
    hostKey: "channels.weixin.qq.com",
    hints: ["微信扫码", "登录", "扫码"],
  },
  {
    id: "jike",
    label: "即刻",
    url: "https://web.okjike.com/",
    hostKey: "okjike.com",
    hints: ["登录", "注册", "验证码", "手机"],
  },
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
  const out = { only: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--only") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.only = raw.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return out;
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

function probeOne(platform) {
  const js = `(() => {
    const txt = (document.body?.innerText || "").replace(/\\s+/g, " ");
    const hints = ${JSON.stringify(platform.hints)};
    const hasLoginHints = hints.some((h) => txt.includes(h));
    return JSON.stringify({
      final_url: location.href,
      title: document.title || "",
      hasLoginHints,
      sample: txt.slice(0, 220),
    });
  })();`;

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
  delay 2
  set foundTab to active tab of front window
end if
set payload to execute foundTab javascript "${escAppleScriptString(js)}"
return payload
end tell`;

  const fallbackScript = `tell application "Google Chrome"
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
  delay 2
  set foundTab to active tab of front window
end if
set outUrl to ""
set outTitle to ""
try
  set outUrl to URL of foundTab
end try
try
  set outTitle to title of foundTab
end try
return "FALLBACK|" & outUrl & "|" & outTitle
end tell`;

  try {
    const raw = runAppleScript(script);
    if (raw.startsWith("ERR|")) {
      return {
        id: platform.id,
        label: platform.label,
        ok: false,
        error: raw,
      };
    }
    const parsed = JSON.parse(raw);
    return {
      id: platform.id,
      label: platform.label,
      target_url: platform.url,
      final_url: parsed.final_url,
      title: parsed.title,
      logged_in_guess: !parsed.hasLoginHints,
      sample: parsed.sample,
      ok: true,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("通过 AppleScript 执行 JavaScript 的功能已关闭")) {
      try {
        const raw2 = runAppleScript(fallbackScript);
        if (raw2.startsWith("FALLBACK|")) {
          const parts = raw2.split("|");
          const finalUrl = parts[1] || "";
          const title = parts.slice(2).join("|");
          return {
            id: platform.id,
            label: platform.label,
            target_url: platform.url,
            final_url: finalUrl,
            title,
            logged_in_guess: null,
            sample: "",
            ok: true,
            fallback: "chrome_applescript_js_disabled",
          };
        }
      } catch (fallbackErr) {
        return {
          id: platform.id,
          label: platform.label,
          target_url: platform.url,
          ok: false,
          error: String(fallbackErr?.message || fallbackErr),
        };
      }
    }
    return {
      id: platform.id,
      label: platform.label,
      target_url: platform.url,
      ok: false,
      error: msg,
    };
  }
}

function main() {
  const args = parseArgs();
  const selected =
    args.only.length > 0 ? PLATFORMS.filter((p) => args.only.includes(p.id)) : PLATFORMS.slice();
  const out = {
    ok: true,
    started_at: new Date().toISOString(),
    mode: "chrome_tabs",
    selected_ids: selected.map((p) => p.id),
    platforms: selected.map((p) => probeOne(p)),
    finished_at: new Date().toISOString(),
  };
  writeJson(OUT_FILE, out);
  console.log(JSON.stringify(out));
}

main();
