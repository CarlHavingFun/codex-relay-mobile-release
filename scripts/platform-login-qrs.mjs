#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const OUT_DIR = path.join(ROOT, "output", "qr_refresh");
const OUT_MANIFEST = path.join(OUT_DIR, "qr_manifest.json");

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
    headless: false,
    timeoutSec: 60,
    only: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--headless") out.headless = true;
    else if (arg === "--headed") out.headless = false;
    else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--only") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.only = raw.split(",").map((s) => s.trim()).filter(Boolean);
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

async function tryClickScanTabs(page) {
  const loginLabels = ["立即登录", "登录", "去登录"];
  for (const label of loginLabels) {
    await page
      .evaluate((target) => {
        const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
        const nodes = Array.from(document.querySelectorAll("button,a,div,span"));
        for (const el of nodes) {
          const t = norm(el.textContent);
          if (!t || t !== target) continue;
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
    await page.waitForTimeout(250);
  }

  const labels = [
    "扫码登录",
    "二维码登录",
    "微信扫码登录",
    "扫码立即下载",
    "微信扫一扫",
    "扫码",
  ];
  for (const label of labels) {
    try {
      const loc = page.getByText(label, { exact: false }).first();
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        await loc.click({ timeout: 1200 }).catch(() => {});
        await page.waitForTimeout(220);
      }
    } catch {}

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
    await page.waitForTimeout(300);
  }
}

async function findQrBox(page) {
  return page.evaluate(() => {
    const selectors = [
      "img[src*='qr' i]",
      "img[src*='qrcode' i]",
      "img[src*='login' i]",
      "[class*='qr' i] img",
      "[class*='qrcode' i] img",
      "canvas",
      "[class*='qr' i]",
      "[class*='qrcode' i]",
      "[id*='qr' i]",
      "[id*='qrcode' i]",
    ];

    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      return true;
    }

    let best = null;
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const el of nodes) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 900 || r.height > 900) continue;

        const cls = `${el.className || ""} ${el.id || ""}`.toLowerCase();
        const src = String(el.getAttribute("src") || "").toLowerCase();
        const tag = String(el.tagName || "");
        let score = 0;
        if (cls.includes("qr") || cls.includes("qrcode")) score += 4;
        if (src.includes("qr") || src.includes("qrcode") || src.includes("login")) score += 5;
        if (tag === "CANVAS") score += 2;

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = Math.hypot(cx - window.innerWidth / 2, cy - window.innerHeight / 2);
        score += Math.max(0, 3 - dist / 260);

        if (!best || score > best.score) {
          best = { x: r.left, y: r.top, width: r.width, height: r.height, score };
        }
      }
    }
    return best;
  });
}

function clampClip(box, viewport) {
  const pad = 26;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const maxW = viewport.width - x;
  const maxH = viewport.height - y;
  const width = Math.max(40, Math.min(maxW, Math.ceil(box.width + pad * 2)));
  const height = Math.max(40, Math.min(maxH, Math.ceil(box.height + pad * 2)));
  return { x, y, width, height };
}

async function captureOne(playwright, p, args) {
  let context;
  const item = {
    id: p.id,
    label: p.label,
    url: p.url,
    profile_dir: p.profileDir,
    ok: false,
  };

  try {
    context = await playwright.chromium.launchPersistentContext(p.profileDir, {
      headless: args.headless,
      viewport: { width: 1440, height: 920 },
      locale: "zh-CN",
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: args.timeoutSec * 1000 });
    await page.waitForTimeout(1800);
    await tryClickScanTabs(page);
    await page.waitForTimeout(1200);

    const fullShot = path.join(OUT_DIR, `${p.id}_full.png`);
    await page.screenshot({ path: fullShot, fullPage: true });

    const box = await findQrBox(page);
    if (box) {
      const vp = page.viewportSize() || { width: 1440, height: 920 };
      const clip = clampClip(box, vp);
      const qrShot = path.join(OUT_DIR, `${p.id}_qr.png`);
      await page.screenshot({ path: qrShot, clip });
      item.qr_image = qrShot;
      item.qr_box = clip;
    } else {
      item.qr_image = fullShot;
      item.qr_box = null;
    }

    const payload = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        final_url: location.href,
        title: document.title || "",
        sample: text.slice(0, 220),
      };
    });

    item.full_image = fullShot;
    item.final_url = payload.final_url;
    item.title = payload.title;
    item.sample = payload.sample;
    item.ok = true;
    return item;
  } catch (err) {
    item.error = String(err?.message || err);
    return item;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs();
  ensureDir(OUT_DIR);

  const selected =
    args.only.length > 0 ? PLATFORMS.filter((p) => args.only.includes(p.id)) : PLATFORMS.slice();
  const result = await withPlaywright(async (playwright) => {
    const items = [];
    for (const p of selected) {
      items.push(await captureOne(playwright, p, args));
    }
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      output_dir: OUT_DIR,
      items,
    };
  });

  writeJson(OUT_MANIFEST, result);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  const out = { ok: false, error: String(err?.message || err) };
  writeJson(OUT_MANIFEST, out);
  console.log(JSON.stringify(out));
  process.exitCode = 1;
});
