#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const PROFILE_DIR = path.join(STATE_DIR, "bilibili-profile");
const PREFS_FILE = path.join(STATE_DIR, "xhs_user_prefs.json");
const NOTE_FILE_MEMO = path.join(ROOT, "output", "小红书_明日发布文案_备忘录.txt");
const NOTE_FILE_LEGACY = path.join(ROOT, "output", "小红书_明日发布文案_记事本.txt");
const SMS_OTP_SCRIPT = path.join(ROOT, "scripts", "sms-otp.mjs");
const RUN_STATE_FILE = path.join(STATE_DIR, "bili_post_last_run.json");

const LOGIN_URL = "https://passport.bilibili.com/login";
const DYNAMIC_URL = "https://member.bilibili.com/platform/upload/dynamic";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function resolveDefaultNoteFile() {
  if (fs.existsSync(NOTE_FILE_MEMO)) return NOTE_FILE_MEMO;
  if (fs.existsSync(NOTE_FILE_LEGACY)) return NOTE_FILE_LEGACY;
  return NOTE_FILE_MEMO;
}

function extractSection(text, name) {
  const re = new RegExp(`【${name}】([\\s\\S]*?)(?=\\n【[^\\n]+】|$)`);
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function normalizePhone(raw) {
  return String(raw || "").replace(/[^\d]/g, "");
}

function loadPhoneFromPrefs() {
  const prefs = readJson(PREFS_FILE, {});
  return normalizePhone(prefs?.phone);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    phone: loadPhoneFromPrefs(),
    noteFile: resolveDefaultNoteFile(),
    content: "",
    contentFile: "",
    timeoutSec: 240,
    smsTimeoutSec: 120,
    smsSinceSec: 300,
    smsPollSec: 2,
    otpCode: "",
    autoSms: false,
    headless: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--phone") {
      out.phone = normalizePhone(args[i + 1] || "");
      i += 1;
    } else if (arg === "--note-file") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.noteFile = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i += 1;
    } else if (arg === "--content-file") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.contentFile = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i += 1;
    } else if (arg === "--content") {
      out.content = String(args[i + 1] || "");
      i += 1;
    } else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--sms-timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.smsTimeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--sms-since-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw >= 0) out.smsSinceSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--sms-poll-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.smsPollSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--otp-code") {
      out.otpCode = String(args[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--auto-sms") {
      out.autoSms = true;
    } else if (arg === "--manual-login") {
      out.autoSms = false;
    } else if (arg === "--headed") {
      out.headless = false;
    } else if (arg === "--headless") {
      out.headless = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    }
  }
  return out;
}

function buildContentFromNote(noteFile) {
  const raw = readText(noteFile);
  const title = extractSection(raw, "标题");
  const body = extractSection(raw, "正文");
  const topics = extractSection(raw, "话题");
  const merged = [title, body, topics].filter(Boolean).join("\n\n").trim();
  return merged;
}

function resolveContent(args) {
  let content = "";
  if (args.content.trim()) {
    content = args.content.trim();
  } else if (args.contentFile) {
    content = readText(args.contentFile).trim();
  } else if (fs.existsSync(args.noteFile)) {
    content = buildContentFromNote(args.noteFile);
  }
  content = content.replace(/\r\n/g, "\n").trim();
  if (!content) throw new Error("missing_content");
  if (content.length > 1000) content = content.slice(0, 990).trimEnd();
  return content;
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

function readOtpFromMessages({ timeoutSec, sinceSec, pollSec }) {
  const child = spawnSync(
    process.execPath,
    [
      SMS_OTP_SCRIPT,
      "--platform",
      "bilibili",
      "--timeout-sec",
      String(timeoutSec),
      "--since-sec",
      String(sinceSec),
      "--poll-sec",
      String(pollSec),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  const parsed = parseJsonFromStdout(child.stdout);
  return {
    status: child.status ?? 1,
    parsed,
    stdout: String(child.stdout || ""),
    stderr: String(child.stderr || ""),
  };
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

async function currentText(page) {
  return page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " "));
}

async function onLoginPage(page) {
  const url = page.url();
  if (url.includes("passport.bilibili.com/login")) return true;
  const text = await currentText(page);
  return (
    (text.includes("短信登录") && text.includes("密码登录") && text.includes("登录/注册")) ||
    (text.includes("登录后你可以") && text.includes("立即登录"))
  );
}

async function waitForManualLogin(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await onLoginPage(page))) return true;
    await page.waitForTimeout(1200);
  }
  return false;
}

async function clickByExactText(page, text) {
  return page.evaluate((targetText) => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const nodes = Array.from(document.querySelectorAll("button,div,span,a"));
    for (const el of nodes) {
      if (clean(el.textContent) !== targetText) continue;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (!r.width || !r.height) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }, text);
}

async function ensureSmsLogin(page, phone) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1500);
  await clickByExactText(page, "短信登录");
  await page.waitForTimeout(500);

  const phoneInput = page.locator("input[placeholder='请输入手机号']").first();
  await phoneInput.waitFor({ state: "visible", timeout: 15000 });
  await phoneInput.fill(phone, { timeout: 10000 });
  await page.waitForTimeout(500);

  const clickedGetCode = await clickByExactText(page, "获取验证码");
  if (!clickedGetCode) throw new Error("sms_get_code_button_not_found");
  await page.waitForTimeout(1200);

  // B站短信发送通常会弹出极验，人机验证需要人工点完后才会真正发码。
  const captchaStart = Date.now();
  while (Date.now() - captchaStart < 180000) {
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const geetestVisible = Array.from(document.querySelectorAll(".geetest_panel,.geetest_holder")).some(
        (el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        },
      );
      const hasCountdown = /\d+\s*秒/.test(text) || text.includes("后重试");
      return {
        geetestVisible,
        hasCountdown,
        hasCaptchaHint:
          text.includes("智能验证") ||
          text.includes("通过验证") ||
          text.includes("请在下图依次点击") ||
          text.includes("安全验证"),
      };
    });

    if (!state.geetestVisible && !state.hasCaptchaHint) break;
    await page.waitForTimeout(1000);
  }

  const finalText = await currentText(page);
  if (finalText.includes("智能验证") || finalText.includes("请在下图依次点击")) {
    throw new Error("sms_requires_manual_captcha");
  }

  if (!/\d+\s*秒/.test(finalText) && finalText.includes("获取验证码")) {
    await clickByExactText(page, "获取验证码");
    await page.waitForTimeout(1000);
  }
}

async function submitOtpLogin(page, code) {
  const codeInput = page.locator("input[placeholder='请输入验证码']").first();
  await codeInput.waitFor({ state: "visible", timeout: 30000 });
  await codeInput.fill(code, { timeout: 10000 });
  await page.waitForTimeout(300);

  const clickedLogin = await clickByExactText(page, "登录/注册");
  if (!clickedLogin) throw new Error("sms_login_submit_button_not_found");

  const start = Date.now();
  while (Date.now() - start < 90000) {
    if (!(await onLoginPage(page))) return true;
    await page.waitForTimeout(800);
  }
  throw new Error("sms_login_not_completed");
}

async function findEditor(page) {
  const textarea = page.locator("textarea").first();
  if (await textarea.count()) {
    if (await textarea.isVisible({ timeout: 1200 }).catch(() => false)) {
      return { type: "textarea", locator: textarea };
    }
  }
  const idx = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("[contenteditable='true']"));
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (!r.width || !r.height) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    return best;
  });
  if (idx >= 0) {
    return { type: "contenteditable", locator: page.locator("[contenteditable='true']").nth(idx) };
  }
  return null;
}

async function openDynamicEditorIfNeeded(page) {
  const quickTry = await findEditor(page);
  if (quickTry) return quickTry;

  const triggers = ["发动态", "发布动态", "写动态", "说点什么", "发表动态"];
  for (const label of triggers) {
    await clickByExactText(page, label);
    await page.waitForTimeout(800);
    const editor = await findEditor(page);
    if (editor) return editor;
  }
  return null;
}

async function fillDynamicContent(page, editor, content) {
  if (!editor) return false;
  if (editor.type === "textarea") {
    await editor.locator.click({ timeout: 5000 });
    await editor.locator.fill(content, { timeout: 12000 });
    return true;
  }

  await editor.locator.click({ timeout: 5000 });
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(content, { delay: 10 });
  return true;
}

async function pickPublishButton(page) {
  const btns = page.locator("button,div");
  const count = await btns.count();
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const node = btns.nth(i);
    let text = "";
    try {
      text = String((await node.innerText({ timeout: 800 })) || "").replace(/\s+/g, " ").trim();
    } catch {
      continue;
    }
    if (!["发布", "发表", "发送"].includes(text)) continue;
    const visible = await node.isVisible({ timeout: 300 }).catch(() => false);
    if (!visible) continue;
    const box = await node.boundingBox().catch(() => null);
    if (!box) continue;
    const candidate = { locator: node, x: box.x, y: box.y };
    if (!best) best = candidate;
    else if (candidate.y > best.y || (candidate.y === best.y && candidate.x > best.x)) best = candidate;
  }
  return best ? best.locator : null;
}

async function waitDynamicPublishResult(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const success =
        text.includes("发布成功") ||
        text.includes("发送成功") ||
        text.includes("动态发布成功") ||
        text.includes("发布完成");
      const fail =
        text.includes("发布失败") ||
        text.includes("发送失败") ||
        text.includes("操作失败") ||
        text.includes("请稍后再试");
      return { success, fail, sample: text.slice(0, 220), url: location.href };
    });
    if (state.fail) throw new Error(`bili_publish_failed_on_page: ${state.sample}`);
    if (state.success) return state;
    await page.waitForTimeout(700);
  }
  throw new Error("bili_publish_result_not_confirmed");
}

async function run(args) {
  const content = resolveContent(args);
  const startedAt = nowIso();

  return withPlaywright(async (playwright) => {
    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: args.headless,
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
      });
      const page = context.pages()[0] || (await context.newPage());

      await page.goto(DYNAMIC_URL, { waitUntil: "domcontentloaded", timeout: args.timeoutSec * 1000 });
      await page.waitForTimeout(1500);

      if (await onLoginPage(page)) {
        if (args.autoSms) {
          if (!args.phone || args.phone.length < 11) {
            throw new Error("missing_phone_number_for_auto_sms");
          }
          if (!fs.existsSync(SMS_OTP_SCRIPT)) throw new Error("sms_otp_script_not_found");
          await ensureSmsLogin(page, args.phone);
          const providedCode = String(args.otpCode || "").replace(/[^\d]/g, "");
          if (providedCode) {
            await submitOtpLogin(page, providedCode);
          } else {
            const otpRes = readOtpFromMessages({
              timeoutSec: args.smsTimeoutSec,
              sinceSec: args.smsSinceSec,
              pollSec: args.smsPollSec,
            });
            const otp = otpRes.parsed;
            if (!otpRes.status || otpRes.status !== 0 || !otp || !otp.ok || !otp.code) {
              throw new Error(`sms_otp_failed: ${otp?.error || "unknown_error"}`);
            }
            await submitOtpLogin(page, String(otp.code));
          }
        } else {
          console.log(
            JSON.stringify({
              ok: true,
              event: "manual_login_required",
              mode: "bili-post",
              message: "Please complete Bilibili login in the opened browser window.",
            }),
          );
          const done = await waitForManualLogin(page, args.timeoutSec * 1000);
          if (!done) {
            throw new Error("manual_login_not_completed");
          }
        }
      }

      await page.goto(DYNAMIC_URL, { waitUntil: "domcontentloaded", timeout: args.timeoutSec * 1000 });
      await page.waitForTimeout(1800);
      if (await onLoginPage(page)) throw new Error("bili_login_required_after_login_step");

      const editor = await openDynamicEditorIfNeeded(page);
      if (!editor) {
        const sample = (await currentText(page)).slice(0, 260);
        throw new Error(`bili_dynamic_editor_not_found: ${sample}`);
      }
      const filled = await fillDynamicContent(page, editor, content);
      if (!filled) throw new Error("bili_dynamic_fill_failed");

      if (!args.dryRun) {
        const publishButton = await pickPublishButton(page);
        if (!publishButton) throw new Error("bili_publish_button_not_found");
        await publishButton.click({ timeout: 10000 });
        await waitDynamicPublishResult(page, 30000);
      }

      const out = {
        ok: true,
        dry_run: args.dryRun,
        started_at: startedAt,
        finished_at: nowIso(),
        url: page.url(),
        content_chars: content.length,
        auto_sms: Boolean(args.autoSms),
        phone_masked: args.phone && args.phone.length >= 7 ? `${args.phone.slice(0, 3)}****${args.phone.slice(-4)}` : null,
      };
      writeJson(RUN_STATE_FILE, out);
      return out;
    } catch (err) {
      const out = {
        ok: false,
        dry_run: args.dryRun,
        started_at: startedAt,
        finished_at: nowIso(),
        error: String(err?.message || err),
      };
      writeJson(RUN_STATE_FILE, out);
      return out;
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

run(parseArgs())
  .then((result) => {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  })
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    process.exitCode = 1;
  });
