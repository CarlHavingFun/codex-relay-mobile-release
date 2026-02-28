#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const OUT_FILE = path.join(STATE_DIR, "platform_login_open_scan.json");

const PLATFORMS = [
  {
    id: "wechat_official",
    label: "微信公众号",
    url: "https://mp.weixin.qq.com/",
    profileDir: path.join(STATE_DIR, "profiles", "wechat_official"),
  },
  {
    id: "bilibili",
    label: "B站",
    url: "https://passport.bilibili.com/login",
    profileDir: path.join(STATE_DIR, "bilibili-profile"),
  },
  {
    id: "weibo",
    label: "微博",
    url: "https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/",
    profileDir: path.join(STATE_DIR, "profiles", "weibo"),
  },
  {
    id: "zhihu",
    label: "知乎",
    url: "https://www.zhihu.com/signin?next=%2F",
    profileDir: path.join(STATE_DIR, "profiles", "zhihu"),
  },
  {
    id: "douyin",
    label: "抖音",
    url: "https://creator.douyin.com/creator-micro/content/post/create",
    profileDir: path.join(STATE_DIR, "profiles", "douyin"),
  },
  {
    id: "kuaishou",
    label: "快手",
    url: "https://cp.kuaishou.com/article/publish/video",
    profileDir: path.join(STATE_DIR, "profiles", "kuaishou"),
  },
  {
    id: "video_channel",
    label: "视频号",
    url: "https://channels.weixin.qq.com/login.html",
    profileDir: path.join(STATE_DIR, "profiles", "video_channel"),
  },
  {
    id: "jike",
    label: "即刻",
    url: "https://web.okjike.com/login?redirect=https%3A%2F%2Fweb.okjike.com%2F",
    profileDir: path.join(STATE_DIR, "profiles", "jike"),
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
    timeoutSec: 60,
    holdMin: 20,
    pulseSec: 20,
    only: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--hold-min") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw)) out.holdMin = Math.floor(raw);
      i += 1;
    } else if (arg === "--pulse-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.pulseSec = Math.floor(raw);
      i += 1;
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

async function tryClickLabels(page, labels) {
  for (const label of labels) {
    await page
      .evaluate((target) => {
        const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
        const nodes = Array.from(document.querySelectorAll("button,a,div,span"));
        for (const el of nodes) {
          const t = norm(el.textContent);
          if (!t || !t.includes(target)) continue;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (r.width < 10 || r.height < 10) continue;
          if (style.display === "none" || style.visibility === "hidden") continue;
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      }, label)
      .catch(() => false);
    await page.waitForTimeout(180).catch(() => {});
  }
}

async function tryClickScanTabs(page) {
  await tryClickLabels(page, ["立即登录", "登录", "去登录"]);
  await tryClickLabels(page, ["扫码登录", "二维码登录", "微信扫码登录", "微信扫一扫", "扫码"]);
}

async function hasQrExpired(page) {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const hints = ["二维码已过期", "二维码失效", "已过期", "点击刷新", "刷新二维码", "重新获取"];
      return hints.some((h) => text.includes(h));
    })
    .catch(() => false);
}

async function pulseOne(session) {
  const page = session.page;
  if (!page || page.isClosed()) return;
  try {
    const expired = await hasQrExpired(page);
    if (expired) {
      await tryClickLabels(page, ["点击刷新", "刷新二维码", "刷新", "重新获取"]);
      await page.waitForTimeout(400).catch(() => {});
    }
    await tryClickScanTabs(page);
    await page.waitForTimeout(150).catch(() => {});
  } catch {
    // Best effort pulse only.
  }
}

async function openOne(playwright, platform, args) {
  const row = {
    id: platform.id,
    label: platform.label,
    url: platform.url,
    profile_dir: platform.profileDir,
    ok: false,
  };
  try {
    const context = await playwright.chromium.launchPersistentContext(platform.profileDir, {
      headless: false,
      viewport: { width: 1440, height: 920 },
      locale: "zh-CN",
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(platform.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutSec * 1000,
    });
    await page.waitForTimeout(1800);
    await tryClickScanTabs(page);
    await page.waitForTimeout(1200);

    row.ok = true;
    row.final_url = page.url();
    row.title = await page.title().catch(() => "");
    return { row, context, page };
  } catch (err) {
    row.error = String(err?.message || err);
    return { row, context: null, page: null };
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

  const startedAt = new Date();
  const result = await withPlaywright(async (playwright) => {
    const rows = [];
    const sessions = [];
    for (const p of selected) {
      const opened = await openOne(playwright, p, args);
      rows.push(opened.row);
      if (opened.context && opened.page) sessions.push(opened);
    }

    const okRows = rows.filter((r) => r.ok);
    console.log(`Opened ${okRows.length}/${rows.length} scan windows.`);
    if (okRows.length > 0) {
      console.log(`Platforms: ${okRows.map((r) => r.id).join(",")}`);
      console.log("Now scan with phone app. Press Ctrl+C after all scans are done.");
    }

    let stop = false;
    const stopHandler = () => {
      stop = true;
    };
    process.on("SIGINT", stopHandler);
    process.on("SIGTERM", stopHandler);

    const holdMs = args.holdMin <= 0 ? Number.POSITIVE_INFINITY : args.holdMin * 60 * 1000;
    const deadline = Date.now() + holdMs;
    while (!stop && Date.now() < deadline) {
      for (const session of sessions) {
        await pulseOne(session);
      }
      await sleep(args.pulseSec * 1000);
    }

    for (const session of sessions) {
      await session.context.close().catch(() => {});
    }
    return {
      ok: true,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      hold_min: args.holdMin,
      pulse_sec: args.pulseSec,
      selected_ids: selected.map((p) => p.id),
      platforms: rows,
    };
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
