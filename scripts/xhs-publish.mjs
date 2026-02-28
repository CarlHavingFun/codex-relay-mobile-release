#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const PROFILE_DIR = path.join(STATE_DIR, "xiaohongshu-profile");
const NOTE_FILE_MEMO = path.join(ROOT, "output", "小红书_明日发布文案_备忘录.txt");
const NOTE_FILE_LEGACY = path.join(ROOT, "output", "小红书_明日发布文案_记事本.txt");
const RUN_STATE_FILE = path.join(STATE_DIR, "xhs_publish_last_run.json");

const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish";

const SAFE_IMAGE_CANDIDATES = [
  path.join(ROOT, "output", "xhs_safe_images", "01_pet_home-1242x2688.png"),
  path.join(ROOT, "output", "xhs_safe_images", "02_chat-1242x2688.png"),
  path.join(ROOT, "output", "xhs_safe_images", "03_buddy-1242x2688.png"),
  path.join(ROOT, "output", "xhs_safe_images", "04_bot_settings-1242x2688.png"),
];

const LEGACY_IMAGE_DIR = process.env.XHS_LEGACY_IMAGE_DIR
  ? path.resolve(process.env.XHS_LEGACY_IMAGE_DIR)
  : "";
const LEGACY_IMAGE_CANDIDATES = LEGACY_IMAGE_DIR
  ? [
      path.join(LEGACY_IMAGE_DIR, "01_pet_home-1242x2688.png"),
      path.join(LEGACY_IMAGE_DIR, "02_chat-1242x2688.png"),
      path.join(LEGACY_IMAGE_DIR, "03_buddy-1242x2688.png"),
      path.join(LEGACY_IMAGE_DIR, "04_bot_settings-1242x2688.png"),
    ]
  : [];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
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
  const iso = `${datePart}T${timePart}:00+08:00`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function resolveDefaultNoteFile() {
  if (fs.existsSync(NOTE_FILE_MEMO)) return NOTE_FILE_MEMO;
  if (fs.existsSync(NOTE_FILE_LEGACY)) return NOTE_FILE_LEGACY;
  return NOTE_FILE_MEMO;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    noteFile: resolveDefaultNoteFile(),
    images: null,
    title: "",
    body: "",
    scheduleBeijing: "",
    usePlatformSchedule: false,
    dryRun: false,
    timeoutSec: 180,
    headless: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--note-file") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.noteFile = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i += 1;
    } else if (arg === "--images") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) {
        out.images = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => (path.isAbsolute(s) ? s : path.join(ROOT, s)));
      }
      i += 1;
    } else if (arg === "--title") {
      out.title = String(args[i + 1] || "");
      i += 1;
    } else if (arg === "--body") {
      out.body = String(args[i + 1] || "");
      i += 1;
    } else if (arg === "--schedule-beijing") {
      out.scheduleBeijing = String(args[i + 1] || "").trim();
      out.usePlatformSchedule = true;
      i += 1;
    } else if (arg === "--platform-schedule") {
      out.usePlatformSchedule = true;
    } else if (arg === "--publish-now") {
      out.usePlatformSchedule = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--headed") {
      out.headless = false;
    } else if (arg === "--headless") {
      out.headless = true;
    }
  }
  return out;
}

function extractSection(text, name) {
  const re = new RegExp(`【${name}】([\\s\\S]*?)(?=\\n【[^\\n]+】|$)`);
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function loadPostFromNote(noteFile) {
  const raw = readText(noteFile);
  const title = extractSection(raw, "标题");
  const body = extractSection(raw, "正文");
  const topics = extractSection(raw, "话题");
  const publishTime =
    extractSection(raw, "发布时间（北京时间）") ||
    extractSection(raw, "发布时间") ||
    extractSection(raw, "发布时间（北京）");
  const content = [body, topics].filter(Boolean).join("\n\n").trim();
  return {
    title,
    content,
    scheduleBeijing: normalizeBeijingDateTime(publishTime),
  };
}

function resolveImages(imagesArg) {
  const list =
    imagesArg && imagesArg.length
      ? imagesArg
      : SAFE_IMAGE_CANDIDATES.every((p) => fs.existsSync(p))
        ? SAFE_IMAGE_CANDIDATES
        : LEGACY_IMAGE_CANDIDATES;
  const existing = list.filter((p) => fs.existsSync(p));
  if (!existing.length) {
    throw new Error("no_image_files_found");
  }
  return existing;
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

async function isLoginPage(page) {
  const url = page.url();
  if (/\/login\b/.test(url) || url.includes("redirectReason=401")) return true;
  const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " "));
  return text.includes("短信登录") && text.includes("验证码");
}

async function ensureImageTab(page) {
  try {
    const result = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("*")).filter(
        (el) => (el.textContent || "").trim() === "上传图文",
      );
      if (!nodes.length) return { ok: false, count: 0 };
      const target = nodes[0];
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { ok: true, count: nodes.length };
    });
    await page.waitForTimeout(700);
    return !!result?.ok;
  } catch {
    return false;
  }
}

function looksLikeImageAccept(accept) {
  const a = String(accept || "").toLowerCase();
  return (
    a.includes("image") ||
    a.includes(".jpg") ||
    a.includes(".jpeg") ||
    a.includes(".png") ||
    a.includes(".webp") ||
    a.includes(".gif")
  );
}

async function chooseImageInput(page) {
  const files = page.locator("input[type='file']");
  const count = await files.count();
  if (!count) return null;
  for (let i = 0; i < count; i += 1) {
    const accept = String((await files.nth(i).getAttribute("accept")) || "");
    if (looksLikeImageAccept(accept)) return files.nth(i);
  }
  return files.first();
}

async function pickImageInputWithRetries(page) {
  for (let i = 0; i < 4; i += 1) {
    await ensureImageTab(page);
    const input = await chooseImageInput(page);
    if (!input) {
      await page.waitForTimeout(500);
      continue;
    }
    const accept = String((await input.getAttribute("accept")) || "");
    if (looksLikeImageAccept(accept)) {
      return input;
    }
    await page.waitForTimeout(600);
  }
  return null;
}

async function fillTitle(page, title) {
  const selectors = [
    "input[placeholder*='标题']",
    "textarea[placeholder*='标题']",
    "input[placeholder*='填写标题']",
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) {
        await loc.fill(title, { timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function pickEditorIndex(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("[contenteditable='true']"));
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 60) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    return best;
  });
}

async function fillBody(page, body) {
  const idx = await pickEditorIndex(page);
  if (idx < 0) return false;
  const editor = page.locator("[contenteditable='true']").nth(idx);
  await editor.click({ timeout: 5000 });
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(body, { delay: 12 });
  return true;
}

async function waitUploads(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ");
        return !text.includes("上传中");
      },
      { timeout: timeoutMs },
    );
  } catch {}
}

async function isDisabled(locator) {
  try {
    return await locator.evaluate((el) => {
      if (!el) return true;
      if (el.hasAttribute("disabled")) return true;
      if (el.getAttribute("aria-disabled") === "true") return true;
      const cls = String(el.className || "");
      return cls.toLowerCase().includes("disabled");
    });
  } catch {
    return true;
  }
}

async function pickBottomButtonByText(page, expectedText) {
  const buttons = page.locator("button");
  const count = await buttons.count();
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const btn = buttons.nth(i);
    let text = "";
    try {
      text = String((await btn.innerText({ timeout: 1000 })) || "").replace(/\s+/g, " ").trim();
    } catch {
      continue;
    }
    if (!text || text !== expectedText) continue;
    const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;
    const box = await btn.boundingBox().catch(() => null);
    if (!box) continue;
    const inScheduleSetting = await btn
      .evaluate((el) => !!el.closest(".post-time-wrapper"))
      .catch(() => false);
    if (inScheduleSetting) continue;
    const candidate = { locator: btn, y: box.y, x: box.x };
    if (!best) best = candidate;
    else if (candidate.y > best.y || (candidate.y === best.y && candidate.x > best.x)) best = candidate;
  }
  return best ? best.locator : null;
}

async function enablePlatformSchedule(page, scheduleBeijing) {
  const wrapper = page.locator(".post-time-wrapper").first();
  try {
    await wrapper.waitFor({ state: "visible", timeout: 10000 });
  } catch {
    throw new Error("platform_schedule_not_supported");
  }

  const checkbox = wrapper.locator("input[type='checkbox']").first();
  let checked = await checkbox.isChecked().catch(() => false);
  if (!checked) {
    const switcher = wrapper.locator(".d-switch").first();
    if (await switcher.isVisible({ timeout: 1200 }).catch(() => false)) {
      await switcher.click({ timeout: 5000 });
    } else {
      await wrapper.click({ timeout: 5000 });
    }
    await page.waitForTimeout(600);
    checked = await checkbox.isChecked().catch(() => false);
  }
  if (!checked) throw new Error("platform_schedule_toggle_failed");

  const dtInput = wrapper.locator("input:not([type='checkbox'])").first();
  try {
    await dtInput.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    throw new Error("platform_schedule_picker_not_found");
  }
  await dtInput.click({ timeout: 5000 });
  await page.keyboard.press("Meta+A");
  await page.keyboard.type(scheduleBeijing, { delay: 12 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  let applied = await dtInput.inputValue().catch(() => "");
  if (!applied || !applied.startsWith(scheduleBeijing)) {
    await dtInput.fill(scheduleBeijing, { timeout: 5000 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    applied = await dtInput.inputValue().catch(() => "");
  }
  if (!applied || !applied.startsWith(scheduleBeijing)) {
    throw new Error("platform_schedule_value_not_applied");
  }
  return applied;
}

async function clickPublish(page, mode = "immediate") {
  const scheduled = mode === "scheduled";
  const label = scheduled ? "定时发布" : "发布";
  async function dismissBlockingOverlays() {
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      await page.keyboard.press("Escape");
    } catch {}
    try {
      await page.evaluate(() => {
        const roots = document.querySelectorAll("[data-tippy-root]");
        roots.forEach((el) => {
          if (el && el.style) el.style.pointerEvents = "none";
        });
        if (document.activeElement && typeof document.activeElement.blur === "function") {
          document.activeElement.blur();
        }
      });
    } catch {}
    await page.waitForTimeout(200);
  }

  async function resolvePublishButton() {
    let button = await pickBottomButtonByText(page, label);
    if (button) return button;
    const fallback = scheduled
      ? page.getByRole("button", { name: /^定时发布$/ }).last()
      : page.getByRole("button", { name: /^发布$/ }).last();
    try {
      if (await fallback.isVisible({ timeout: 1500 })) return fallback;
    } catch {}
    return null;
  }

  let button = await resolvePublishButton();
  if (!button) throw new Error("publish_button_not_found");

  const started = Date.now();
  while (Date.now() - started < 60000) {
    const disabled = await isDisabled(button);
    if (!disabled) break;
    await page.waitForTimeout(1000);
  }
  let clicked = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    button = (await resolvePublishButton()) || button;
    try {
      await button.evaluate((el) => {
        if (el && typeof el.click === "function") el.click();
      });
      await page.waitForTimeout(250);
      // Keep a native click attempt to cover handlers bound to pointer flows.
      await button.click({ timeout: 4000 }).catch(() => {});
      clicked = true;
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      const likelyOverlay = msg.includes("intercepts pointer events") || msg.includes("Timeout");
      if (!likelyOverlay || attempt === 3) {
        try {
          await button.click({ timeout: 4000, force: true });
          clicked = true;
          break;
        } catch {
          throw err;
        }
      }
      await dismissBlockingOverlays();
    }
  }
  if (!clicked) throw new Error("publish_click_failed");
  await dismissBlockingOverlays();

  // Some accounts may see an additional confirm step.
  const confirmNames = scheduled
    ? ["确认发布", "继续发布", "确定", "定时发布"]
    : ["确认发布", "继续发布", "立即发布"];
  for (const name of confirmNames) {
    const btn = page.getByRole("button", { name }).first();
    try {
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 5000 });
      }
    } catch {}
  }
}

async function waitPublishResult(page, timeoutMs, mode = "immediate", startUrl = "", expectedTitle = "") {
  const scheduled = mode === "scheduled";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(
      ({ isScheduled, beginUrl, title }) => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ");
        const url = location.href;
        const movedToManager =
          url !== beginUrl && (url.includes("/note-manager") || url.includes("/new/note-manager"));
        const hasTitle = title ? text.includes(title) : false;
        const hasFailure =
          text.includes("发布失败") ||
          text.includes("操作失败") ||
          text.includes("请稍后再试") ||
          text.includes("频繁");

        if (isScheduled) {
          const success =
            text.includes("定时发布成功") ||
            (hasTitle && text.includes("定时发布")) ||
            (movedToManager && hasTitle && text.includes("定时发布"));
          return { success, failure: hasFailure, url, sample: text.slice(0, 240) };
        }

        const immediateSuccess =
          text.includes("发布成功") ||
          (movedToManager && hasTitle && (text.includes("发布于") || text.includes("审核中")));
        return { success: immediateSuccess, failure: hasFailure, url, sample: text.slice(0, 240) };
      },
      {
        isScheduled: scheduled,
        beginUrl: startUrl,
        title: expectedTitle,
      },
    );

    if (state.failure) {
      throw new Error(`publish_failed_on_page: ${state.sample}`);
    }
    if (state.success) return;
    await page.waitForTimeout(800);
  }
  throw new Error("publish_result_not_confirmed");
}

async function runPublish(args) {
  const fromNote = loadPostFromNote(args.noteFile);
  const title = String(args.title || fromNote.title || "").trim();
  const body = String(args.body || fromNote.content || "").trim();
  const scheduleFromArg = normalizeBeijingDateTime(args.scheduleBeijing);
  const scheduleFromNote = normalizeBeijingDateTime(fromNote.scheduleBeijing);
  const usePlatformSchedule = args.usePlatformSchedule || !!scheduleFromArg;
  const scheduleBeijing = scheduleFromArg || (args.usePlatformSchedule ? scheduleFromNote : null);

  if (!title) throw new Error("missing_title");
  if (!body) throw new Error("missing_body");
  if (usePlatformSchedule && !scheduleBeijing) {
    throw new Error("missing_schedule_beijing_time");
  }
  if (usePlatformSchedule) {
    const target = parseBeijingToDate(scheduleBeijing);
    if (!target) throw new Error("invalid_schedule_beijing_time");
    if (target.getTime() <= Date.now() + 2 * 60 * 1000) {
      throw new Error("schedule_time_too_soon_or_in_past");
    }
  }
  const images = resolveImages(args.images);

  return withPlaywright(async (playwright) => {
    let context;
    let page;
    const startedAt = nowIso();
    let publishMode = "immediate";
    let scheduledApplied = null;
    try {
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: args.headless,
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      });
      page = context.pages()[0] || (await context.newPage());
      await page.goto(PUBLISH_URL, {
        waitUntil: "domcontentloaded",
        timeout: args.timeoutSec * 1000,
      });
      await page.waitForTimeout(1200);

      if (await isLoginPage(page)) {
        throw new Error("not_logged_in");
      }

      const input = await pickImageInputWithRetries(page);
      if (!input) throw new Error("image_file_input_not_found");
      const multiple = await input.evaluate((el) => !!el.multiple).catch(() => false);
      const filesToUpload = multiple ? images : [images[0]];
      await input.setInputFiles(filesToUpload);
      await page.waitForTimeout(1000);

      const titleOk = await fillTitle(page, title);
      if (!titleOk) throw new Error("title_input_not_found");
      const bodyOk = await fillBody(page, body);
      if (!bodyOk) throw new Error("body_editor_not_found");

      await waitUploads(page, 120000);

      if (usePlatformSchedule) {
        scheduledApplied = await enablePlatformSchedule(page, scheduleBeijing);
        publishMode = "scheduled";
      }

      const startUrl = page.url();
      if (!args.dryRun) {
        await clickPublish(page, publishMode);
        await waitPublishResult(page, 45000, publishMode, startUrl, title);
      }

      const result = {
        ok: true,
        dry_run: args.dryRun,
        publish_mode: publishMode,
        scheduled_beijing: scheduledApplied,
        started_at: startedAt,
        finished_at: nowIso(),
        url: page.url(),
        title_preview: title.slice(0, 60),
        body_chars: body.length,
        image_count: images.length,
      };
      writeJson(RUN_STATE_FILE, result);
      return result;
    } catch (err) {
      const result = {
        ok: false,
        dry_run: args.dryRun,
        publish_mode: publishMode,
        scheduled_beijing: scheduledApplied,
        started_at: startedAt,
        finished_at: nowIso(),
        error: String(err?.message || err),
      };
      if (page) {
        try {
          const debugDir = path.join(ROOT, "output", "playwright");
          ensureDir(debugDir);
          const stamp = Date.now();
          const shot = path.join(debugDir, `xhs_publish_fail_${stamp}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          result.debug_screenshot = shot;
          result.debug_url = page.url();
          result.debug_sample = await page.evaluate(() =>
            (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400),
          );
        } catch {}
      }
      writeJson(RUN_STATE_FILE, result);
      return result;
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

async function main() {
  const args = parseArgs();
  const result = await runPublish(args);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exitCode = 1;
});
