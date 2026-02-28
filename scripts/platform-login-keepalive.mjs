#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const OUT_FILE = path.join(STATE_DIR, "platform_login_keepalive.json");

const PROFILE_OVERRIDES = {
  xiaohongshu: path.join(STATE_DIR, "xiaohongshu-profile"),
  bilibili: path.join(STATE_DIR, "bilibili-profile"),
};

const PLATFORMS = [
  {
    id: "xiaohongshu",
    label: "小红书",
    url: "https://creator.xiaohongshu.com/publish/publish",
    hints: ["短信登录", "扫码登录", "登录后"],
  },
  {
    id: "bilibili",
    label: "B站",
    url: "https://member.bilibili.com/platform/upload/dynamic",
    hints: ["账号登录", "短信登录", "扫码登录", "立即登录"],
  },
  {
    id: "weibo",
    label: "微博",
    url: "https://weibo.com/",
    hints: ["登录", "注册", "手机验证码"],
  },
  {
    id: "zhihu",
    label: "知乎",
    url: "https://www.zhihu.com/",
    hints: ["登录", "注册", "验证码", "手机号"],
  },
  {
    id: "douyin",
    label: "抖音",
    url: "https://creator.douyin.com/creator-micro/content/post/create",
    hints: ["登录", "验证码", "手机登录", "扫码登录"],
  },
  {
    id: "kuaishou",
    label: "快手",
    url: "https://cp.kuaishou.com/article/publish/video",
    hints: ["登录", "验证码", "手机号", "扫码"],
  },
  {
    id: "wechat_official",
    label: "微信公众号",
    url: "https://mp.weixin.qq.com/",
    hints: ["请使用微信扫描二维码登录", "扫码", "登录"],
  },
  {
    id: "video_channel",
    label: "视频号",
    url: "https://channels.weixin.qq.com/platform",
    hints: ["微信扫码", "登录", "扫码"],
  },
  {
    id: "jike",
    label: "即刻",
    url: "https://web.okjike.com/",
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
  const out = {
    intervalMin: 25,
    timeoutSec: 45,
    forever: false,
    rounds: 1,
    only: [],
    headless: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--interval-min") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.intervalMin = Math.floor(raw);
      i += 1;
    } else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--rounds") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.rounds = Math.floor(raw);
      i += 1;
    } else if (arg === "--forever") {
      out.forever = true;
    } else if (arg === "--headed") {
      out.headless = false;
    } else if (arg === "--headless") {
      out.headless = true;
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

async function withPlaywright(fn) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (err) {
    return {
      ok: false,
      error: `playwright_not_installed: ${String(err?.message || err)}`,
      action: "npm i -D playwright",
    };
  }
  return fn(playwright);
}

async function probeOne(playwright, platform, args) {
  const override = PROFILE_OVERRIDES[platform.id];
  const profileDir =
    override && fs.existsSync(override) ? override : path.join(STATE_DIR, "profiles", platform.id);
  let context;
  const row = {
    id: platform.id,
    label: platform.label,
    profile_dir: profileDir,
    target_url: platform.url,
    ok: false,
  };
  try {
    context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: args.headless,
      viewport: { width: 1280, height: 880 },
      locale: "zh-CN",
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(platform.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutSec * 1000,
    });
    await page.waitForTimeout(1400);

    const payload = await page.evaluate((hints) => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const hasLoginHints = hints.some((hint) => text.includes(hint));
      return {
        url: location.href,
        title: document.title || "",
        hasLoginHints,
      };
    }, platform.hints);

    row.ok = true;
    row.final_url = payload.url;
    row.title = payload.title;
    row.logged_in_guess = !payload.hasLoginHints;
    return row;
  } catch (err) {
    row.error = String(err?.message || err);
    return row;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function runRound(playwright, selected, args, roundNo) {
  const startedAt = new Date().toISOString();
  const platforms = [];
  for (const p of selected) {
    platforms.push(await probeOne(playwright, p, args));
  }
  const loggedIn = platforms.filter((p) => p.logged_in_guess === true).map((p) => p.id);
  const loggedOut = platforms.filter((p) => p.logged_in_guess === false).map((p) => p.id);
  return {
    round: roundNo,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    logged_in_ids: loggedIn,
    logged_out_ids: loggedOut,
    platforms,
  };
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

  const startedAt = new Date().toISOString();
  const out = {
    ok: true,
    mode: args.forever ? "forever" : "fixed_rounds",
    interval_min: args.intervalMin,
    timeout_sec: args.timeoutSec,
    headless: args.headless,
    selected_ids: selected.map((p) => p.id),
    started_at: startedAt,
    rounds: [],
  };

  let stop = false;
  const stopHandler = () => {
    stop = true;
  };
  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  const result = await withPlaywright(async (playwright) => {
    let roundNo = 1;
    while (!stop) {
      const round = await runRound(playwright, selected, args, roundNo);
      out.rounds.push(round);
      out.last_round = round;
      out.finished_at = new Date().toISOString();
      writeJson(OUT_FILE, out);
      console.log(
        `[keepalive] round=${roundNo} in=${round.logged_in_ids.length} out=${round.logged_out_ids.length}`
      );

      if (!args.forever && roundNo >= args.rounds) break;
      roundNo += 1;
      if (stop) break;
      await sleep(args.intervalMin * 60 * 1000);
    }

    out.finished_at = new Date().toISOString();
    return out;
  });

  writeJson(OUT_FILE, result);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  const out = { ok: false, error: String(err?.message || err) };
  writeJson(OUT_FILE, out);
  console.log(JSON.stringify(out));
  process.exitCode = 1;
});
