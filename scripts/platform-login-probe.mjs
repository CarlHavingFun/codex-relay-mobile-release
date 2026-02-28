#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const OUT_FILE = path.join(STATE_DIR, "platform_login_probe.json");
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
    id: "toutiao",
    label: "头条号",
    url: "https://mp.toutiao.com/profile_v4/",
    hints: ["登录", "验证码", "手机号", "扫码"],
  },
  {
    id: "baijiahao",
    label: "百家号",
    url: "https://baijiahao.baidu.com/",
    hints: ["登录", "验证码", "手机号", "扫码"],
  },
  {
    id: "penguin",
    label: "企鹅号",
    url: "https://om.qq.com/main",
    hints: ["登录", "验证码", "微信登录", "QQ登录"],
  },
  {
    id: "sohu",
    label: "搜狐号",
    url: "https://mp.sohu.com/mpfe/v3/main/news/addarticle",
    hints: ["登录", "验证码", "手机登录", "扫码"],
  },
  {
    id: "wangyi",
    label: "网易号",
    url: "https://mp.163.com/",
    hints: ["登录", "验证码", "手机登录", "扫码"],
  },
  {
    id: "douban",
    label: "豆瓣",
    url: "https://www.douban.com/",
    hints: ["登录", "注册", "手机验证码"],
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
  const out = { headless: true, timeoutSec: 45 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--headed") out.headless = false;
    else if (arg === "--headless") out.headless = true;
    else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    }
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
    await page.waitForTimeout(1800);

    const payload = await page.evaluate((hints) => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const hasLoginHints = hints.some((hint) => text.includes(hint));
      return {
        url: location.href,
        title: document.title || "",
        hasLoginHints,
        sample: text.slice(0, 220),
      };
    }, platform.hints);

    return {
      id: platform.id,
      label: platform.label,
      profile_dir: profileDir,
      target_url: platform.url,
      final_url: payload.url,
      title: payload.title,
      logged_in_guess: !payload.hasLoginHints,
      sample: payload.sample,
      ok: true,
    };
  } catch (err) {
    return {
      id: platform.id,
      label: platform.label,
      profile_dir: profileDir,
      target_url: platform.url,
      ok: false,
      error: String(err?.message || err),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  const result = await withPlaywright(async (playwright) => {
    const rows = [];
    for (const platform of PLATFORMS) {
      rows.push(await probeOne(playwright, platform, args));
    }
    return {
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
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
