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
const PROFILE_DIR = path.join(STATE_DIR, "xiaohongshu-profile");
const SESSION_FILE = path.join(STATE_DIR, "xhs_session_state.json");
const PREFS_FILE = path.join(STATE_DIR, "xhs_user_prefs.json");
const DEFAULT_QR_FILE = path.join(ROOT, "output", "playwright", "xhs-login-qr.png");
const SMS_OTP_SCRIPT = path.join(ROOT, "scripts", "sms-otp.mjs");

const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish";
const USER_INFO_URL = "https://creator.xiaohongshu.com/api/galaxy/user/info";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    mode: "probe",
    timeoutSec: 300,
    qrFile: DEFAULT_QR_FILE,
    phone: null,
    smsTimeoutSec: 120,
    smsPollSec: 2,
    smsSinceSec: 300,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--probe") out.mode = "probe";
    else if (arg === "--login") out.mode = "login";
    else if (arg === "--login-sms") out.mode = "login-sms";
    else if (arg === "--login-qr") out.mode = "login-qr";
    else if (arg === "--ensure-login") out.mode = "ensure-login";
    else if (arg === "--logout") out.mode = "logout";
    else if (arg === "--show-phone") out.mode = "show-phone";
    else if (arg === "--set-phone") {
      out.mode = "set-phone";
      out.phone = String(args[i + 1] || "").trim();
      i += 1;
    }
    else if (arg === "--clear-phone") out.mode = "clear-phone";
    else if (arg === "--phone") {
      out.phone = String(args[i + 1] || "").trim();
      i += 1;
    }
    else if (arg === "--qr-file") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.qrFile = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i += 1;
    }
    else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    }
    else if (arg === "--sms-timeout-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.smsTimeoutSec = Math.floor(raw);
      i += 1;
    }
    else if (arg === "--sms-poll-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw > 0) out.smsPollSec = Math.floor(raw);
      i += 1;
    }
    else if (arg === "--sms-since-sec") {
      const raw = Number(args[i + 1]);
      if (Number.isFinite(raw) && raw >= 0) out.smsSinceSec = Math.floor(raw);
      i += 1;
    }
  }
  return out;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return null;
  return digits;
}

function loadPrefs() {
  const parsed = readJson(PREFS_FILE, {});
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function savePrefs(prefs) {
  writeJson(PREFS_FILE, prefs);
  try {
    fs.chmodSync(PREFS_FILE, 0o600);
  } catch {}
}

function maskedPhone(phone) {
  const p = String(phone || "");
  if (p.length < 7) return p;
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

function resolvePhone(argsPhone) {
  const normalizedArg = normalizePhone(argsPhone);
  if (normalizedArg) return normalizedArg;
  const prefs = loadPrefs();
  return normalizePhone(prefs.phone);
}

function runSetPhone(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone || phone.length < 7) {
    return {
      ok: false,
      mode: "set-phone",
      error: "invalid_phone",
    };
  }
  const prefs = loadPrefs();
  const next = {
    ...prefs,
    phone,
    phone_updated_at: nowIso(),
  };
  savePrefs(next);
  return {
    ok: true,
    mode: "set-phone",
    phone_masked: maskedPhone(phone),
    prefs_file: PREFS_FILE,
  };
}

function runShowPhone() {
  const phone = resolvePhone(null);
  return {
    ok: true,
    mode: "show-phone",
    has_phone: !!phone,
    phone_masked: phone ? maskedPhone(phone) : null,
    prefs_file: PREFS_FILE,
  };
}

function runClearPhone() {
  const prefs = loadPrefs();
  if (Object.hasOwn(prefs, "phone")) delete prefs.phone;
  if (Object.hasOwn(prefs, "phone_updated_at")) delete prefs.phone_updated_at;
  savePrefs(prefs);
  return {
    ok: true,
    mode: "clear-phone",
    prefs_file: PREFS_FILE,
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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractUserSummary(body) {
  if (!body || typeof body !== "object") return null;
  const data = body.data && typeof body.data === "object" ? body.data : null;
  const candidate =
    (data && (data.nickname || data.name || data.user_name || data.username)) ||
    body.nickname ||
    body.username ||
    null;
  return candidate ? String(candidate) : null;
}

function isUserInfoAuthed(status, body) {
  if (status !== 200) return false;
  if (!body || typeof body !== "object") return true;
  if (Object.hasOwn(body, "success") && body.success === false) return false;
  if (Object.hasOwn(body, "code") && Number(body.code) !== 0) return false;
  return true;
}

async function collectAuthState(context, page) {
  const url = page.url();
  const markers = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    return {
      title: document.title || "",
      loginHints:
        text.includes("短信登录") ||
        text.includes("扫一扫登录") ||
        text.includes("二维码已过期") ||
        text.includes("登录"),
      qrExpired: text.includes("二维码已过期"),
    };
  });

  let userInfoStatus = null;
  let userInfoBody = null;
  let userInfoError = null;
  try {
    const res = await context.request.get(USER_INFO_URL, { timeout: 15000 });
    userInfoStatus = res.status();
    userInfoBody = await safeJson(res);
  } catch (err) {
    userInfoError = String(err?.message || err);
  }

  const loginUrl = /\/login\b/.test(url) || url.includes("redirectReason=401");
  const apiAuthed = isUserInfoAuthed(userInfoStatus, userInfoBody);
  const pageAuthed = !loginUrl && !markers.loginHints;
  const authenticated = pageAuthed || (!loginUrl && apiAuthed);
  const authSource = authenticated
    ? apiAuthed
      ? "api_or_page"
      : "page"
    : "none";

  return {
    authenticated,
    auth_source: authSource,
    login_url: loginUrl,
    url,
    title: markers.title,
    qr_expired: markers.qrExpired,
    has_login_hints: markers.loginHints,
    user_info_status: userInfoStatus,
    user_info_error: userInfoError,
    user: extractUserSummary(userInfoBody),
  };
}

async function launchContext(playwright, { headless }) {
  ensureDir(PROFILE_DIR);
  return playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
}

function persistSessionState(payload) {
  writeJson(SESSION_FILE, {
    at: nowIso(),
    profile_dir: PROFILE_DIR,
    ...payload,
  });
}

async function runProbe(playwright) {
  let context;
  try {
    context = await launchContext(playwright, { headless: true });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(PUBLISH_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(1200);
    const auth = await collectAuthState(context, page);
    persistSessionState({
      mode: "probe",
      authenticated: auth.authenticated,
      url: auth.url,
      user: auth.user || null,
    });
    return {
      ok: true,
      mode: "probe",
      profile_dir: PROFILE_DIR,
      ...auth,
    };
  } catch (err) {
    persistSessionState({
      mode: "probe",
      authenticated: false,
      error: String(err?.message || err),
    });
    return {
      ok: false,
      mode: "probe",
      profile_dir: PROFILE_DIR,
      error: String(err?.message || err),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function tryRefreshQr(page) {
  try {
    const btn = page.getByText("返回重新扫描");
    if (await btn.isVisible({ timeout: 800 })) {
      await btn.click({ timeout: 2000 });
      return true;
    }
  } catch {}
  return false;
}

async function ensureQrMode(page) {
  try {
    if (await page.getByText("APP扫一扫登录").first().isVisible({ timeout: 800 })) {
      return true;
    }
  } catch {}
  try {
    const clicked = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      if (bodyText.includes("APP扫一扫登录")) return true;
      const smsNode = Array.from(document.querySelectorAll("*")).find(
        (el) => (el.textContent || "").trim() === "短信登录",
      );
      if (!smsNode) return false;
      let cur = smsNode;
      for (let i = 0; i < 8 && cur; i += 1) {
        const scope = cur.parentElement || cur;
        const imgs = Array.from(scope.querySelectorAll("img"));
        const icon = imgs.find((img) => {
          const r = img.getBoundingClientRect();
          return r.width >= 12 && r.width <= 64 && r.height >= 12 && r.height <= 64;
        });
        if (icon) {
          icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(500);
    }
  } catch {}

  try {
    return await page.getByText("APP扫一扫登录").first().isVisible({ timeout: 1200 });
  } catch {
    return false;
  }
}

async function findQrSrc(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      const r = img.getBoundingClientRect();
      const sizeOk = r.width >= 120 && r.width <= 260 && r.height >= 120 && r.height <= 260;
      const srcOk = src.startsWith("data:image/") || src.startsWith("https://") || src.startsWith("http://");
      if (sizeOk && srcOk) return src;
    }
    return null;
  });
}

async function saveQrFromSrc(context, src, qrFile) {
  ensureDir(path.dirname(qrFile));
  if (typeof src !== "string" || !src) {
    return { ok: false, error: "qr_src_missing" };
  }
  if (src.startsWith("data:image/")) {
    const comma = src.indexOf(",");
    if (comma < 0) return { ok: false, error: "qr_data_url_invalid" };
    const raw = src.slice(comma + 1);
    fs.writeFileSync(qrFile, Buffer.from(raw, "base64"));
    return { ok: true, qr_file: qrFile, bytes: fs.statSync(qrFile).size };
  }
  if (src.startsWith("http://") || src.startsWith("https://")) {
    const res = await context.request.get(src, { timeout: 15000 });
    if (!res.ok()) {
      return { ok: false, error: `qr_download_failed_status_${res.status()}` };
    }
    const body = await res.body();
    fs.writeFileSync(qrFile, body);
    return { ok: true, qr_file: qrFile, bytes: fs.statSync(qrFile).size };
  }
  return { ok: false, error: "qr_src_unsupported" };
}

async function exportQrImage(context, page, qrFile) {
  const inQrMode = await ensureQrMode(page);
  if (!inQrMode) {
    return { ok: false, error: "qr_mode_not_ready" };
  }
  const src = await findQrSrc(page);
  return saveQrFromSrc(context, src, qrFile);
}

async function tryPrefillPhone(page, phone) {
  if (!phone) return false;
  try {
    await page.getByRole("textbox", { name: "手机号" }).fill(phone, { timeout: 1200 });
    return true;
  } catch {}
  try {
    await page.locator("input[placeholder='手机号']").first().fill(phone, { timeout: 1200 });
    return true;
  } catch {}
  try {
    const done = await page.evaluate((v) => {
      const input = document.querySelector("input[placeholder='手机号']");
      if (!input) return false;
      input.focus();
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, phone);
    return !!done;
  } catch {
    return false;
  }
}

function parseLastJsonLine(raw) {
  const lines = String(raw || "")
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

function lookupOtpFromMac({ timeoutSec, pollSec, sinceSec }) {
  const child = spawnSync(
    process.execPath,
    [
      SMS_OTP_SCRIPT,
      "--platform",
      "xiaohongshu",
      "--timeout-sec",
      String(timeoutSec),
      "--poll-sec",
      String(pollSec),
      "--since-sec",
      String(sinceSec),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  const parsed = parseLastJsonLine(child.stdout);
  if (child.status === 0 && parsed?.ok && parsed.code) {
    return {
      ok: true,
      code: String(parsed.code),
      sender: parsed.sender || null,
      received_at: parsed.received_at || null,
    };
  }
  if (parsed && parsed.error) {
    return {
      ok: false,
      error: String(parsed.error),
      detail: parsed.detail || null,
      action: parsed.action || null,
      exit_status: child.status,
    };
  }
  return {
    ok: false,
    error: "otp_lookup_failed",
    detail: String(child.stderr || child.stdout || "").trim() || null,
    exit_status: child.status,
  };
}

async function ensureSmsLoginMode(page) {
  try {
    const phoneInput = page.locator("input[placeholder*='手机号']").first();
    if (await phoneInput.isVisible({ timeout: 800 })) return true;
  } catch {}

  const labelCandidates = [
    page.getByText("短信登录", { exact: true }).first(),
    page.getByText("手机号登录").first(),
  ];
  for (const c of labelCandidates) {
    try {
      if (await c.isVisible({ timeout: 1200 })) {
        await c.click({ timeout: 2000 });
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }

  try {
    const clicked = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*")).find((el) => {
        const t = (el.textContent || "").trim();
        return t === "短信登录" || t === "手机号登录";
      });
      if (!node) return false;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    });
    if (clicked) await page.waitForTimeout(600);
  } catch {}

  try {
    return await page.locator("input[placeholder*='手机号']").first().isVisible({ timeout: 1200 });
  } catch {
    return false;
  }
}

async function clickSendCode(page) {
  const candidates = [
    page.getByRole("button", { name: /获取验证码|发送验证码/ }).first(),
    page.getByText("获取验证码", { exact: true }).first(),
    page.getByText("发送验证码", { exact: true }).first(),
  ];
  for (const c of candidates) {
    try {
      if (await c.isVisible({ timeout: 1200 })) {
        await c.click({ timeout: 4000 });
        return true;
      }
    } catch {}
  }
  try {
    const clicked = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("button,div,span")).find((el) => {
        const t = (el.textContent || "").trim();
        return t.includes("验证码") && (t.includes("获取") || t.includes("发送"));
      });
      if (!node) return false;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    });
    return !!clicked;
  } catch {
    return false;
  }
}

async function fillSmsCode(page, code) {
  const selectors = [
    "input[placeholder*='验证码']",
    "input[inputmode='numeric']",
    "input[maxlength='6']",
  ];
  for (const sel of selectors) {
    const input = page.locator(sel).first();
    try {
      if (await input.isVisible({ timeout: 1200 })) {
        await input.fill(String(code), { timeout: 4000 });
        return true;
      }
    } catch {}
  }
  try {
    const ok = await page.evaluate((value) => {
      const input = document.querySelector("input[placeholder*='验证码']");
      if (!input) return false;
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, String(code));
    return !!ok;
  } catch {
    return false;
  }
}

async function runLogin(playwright, timeoutSec, phoneInput, options = {}) {
  const modeLabel = options.modeLabel || "login";
  let context;
  try {
    context = await launchContext(playwright, { headless: false });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(PUBLISH_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const phone = resolvePhone(phoneInput);
    await tryPrefillPhone(page, phone);

    const smsAuto = {
      enabled: !!options.autoSms,
      code_requested: false,
      otp_found: false,
      otp_filled: false,
      otp_sender: null,
      otp_received_at: null,
      error: null,
      detail: null,
      action: null,
    };
    if (options.autoSms) {
      const smsModeReady = await ensureSmsLoginMode(page);
      if (!smsModeReady) {
        smsAuto.error = "sms_login_mode_not_found";
      } else if (!phone) {
        smsAuto.error = "phone_missing_for_sms_login";
      } else {
        await tryPrefillPhone(page, phone);
        const requested = await clickSendCode(page);
        smsAuto.code_requested = requested;
        const lookup = lookupOtpFromMac({
          timeoutSec: options.smsTimeoutSec || 120,
          pollSec: options.smsPollSec || 2,
          sinceSec: options.smsSinceSec || 300,
        });
        if (lookup.ok && lookup.code) {
          smsAuto.otp_found = true;
          smsAuto.otp_sender = lookup.sender;
          smsAuto.otp_received_at = lookup.received_at;
          const filled = await fillSmsCode(page, lookup.code);
          smsAuto.otp_filled = filled;
          if (filled) {
            await page.keyboard.press("Enter").catch(() => {});
          }
        } else {
          smsAuto.error = lookup.error || "otp_lookup_failed";
          smsAuto.detail = lookup.detail || null;
          smsAuto.action = lookup.action || null;
        }
      }
    }

    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < timeoutSec * 1000) {
      last = await collectAuthState(context, page);
      if (last.authenticated) {
        persistSessionState({
          mode: modeLabel,
          authenticated: true,
          url: last.url,
          user: last.user || null,
          saved_at: nowIso(),
        });
        return {
          ok: true,
          mode: modeLabel,
          profile_dir: PROFILE_DIR,
          message: "login_saved",
          sms_auto: smsAuto.enabled ? smsAuto : null,
          ...last,
        };
      }
      if (last.qr_expired) {
        await tryRefreshQr(page);
      }
      await page.waitForTimeout(1500);
    }

    persistSessionState({
      mode: modeLabel,
      authenticated: false,
      timeout: true,
      url: last?.url || null,
    });
    return {
      ok: false,
      mode: modeLabel,
      profile_dir: PROFILE_DIR,
      timeout: true,
      message: "login_timeout_or_not_completed",
      sms_auto: smsAuto.enabled ? smsAuto : null,
      ...last,
    };
  } catch (err) {
    persistSessionState({
      mode: modeLabel,
      authenticated: false,
      error: String(err?.message || err),
    });
    return {
      ok: false,
      mode: modeLabel,
      profile_dir: PROFILE_DIR,
      error: String(err?.message || err),
      sms_auto: options.autoSms ? { enabled: true, error: "login_exception" } : null,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function runQrLogin(playwright, timeoutSec, qrFile) {
  let context;
  try {
    context = await launchContext(playwright, { headless: true });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(PUBLISH_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(1000);

    let last = null;
    let qrReady = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutSec * 1000) {
      last = await collectAuthState(context, page);
      if (last.authenticated) {
        persistSessionState({
          mode: "login-qr",
          authenticated: true,
          url: last.url,
          user: last.user || null,
          saved_at: nowIso(),
          qr_file: qrFile,
        });
        return {
          ok: true,
          mode: "login-qr",
          profile_dir: PROFILE_DIR,
          qr_file: qrFile,
          message: "login_saved",
          ...last,
        };
      }

      if (!qrReady || last.qr_expired) {
        if (last.qr_expired) {
          await tryRefreshQr(page);
        }
        const qr = await exportQrImage(context, page, qrFile);
        if (qr.ok) {
          qrReady = true;
          console.log(
            JSON.stringify({
              ok: true,
              event: "qr_ready",
              mode: "login-qr",
              qr_file: qr.qr_file,
              bytes: qr.bytes,
              at: nowIso(),
            }),
          );
        }
      }

      await page.waitForTimeout(1500);
    }

    persistSessionState({
      mode: "login-qr",
      authenticated: false,
      timeout: true,
      url: last?.url || null,
      qr_file: qrFile,
    });
    return {
      ok: false,
      mode: "login-qr",
      profile_dir: PROFILE_DIR,
      qr_file: qrFile,
      timeout: true,
      message: "login_timeout_or_not_completed",
      ...last,
    };
  } catch (err) {
    persistSessionState({
      mode: "login-qr",
      authenticated: false,
      error: String(err?.message || err),
      qr_file: qrFile,
    });
    return {
      ok: false,
      mode: "login-qr",
      profile_dir: PROFILE_DIR,
      qr_file: qrFile,
      error: String(err?.message || err),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

function runLogout() {
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    persistSessionState({
      mode: "logout",
      authenticated: false,
      removed_profile: true,
    });
    return {
      ok: true,
      mode: "logout",
      profile_dir: PROFILE_DIR,
      removed_profile: true,
    };
  } catch (err) {
    return {
      ok: false,
      mode: "logout",
      profile_dir: PROFILE_DIR,
      error: String(err?.message || err),
    };
  }
}

async function main() {
  const args = parseArgs();
  if (args.mode === "set-phone") {
    const result = runSetPhone(args.phone);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.mode === "show-phone") {
    console.log(JSON.stringify(runShowPhone()));
    return;
  }
  if (args.mode === "clear-phone") {
    console.log(JSON.stringify(runClearPhone()));
    return;
  }
  if (args.mode === "logout") {
    const result = runLogout();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const result = await withPlaywright(async (playwright) => {
    if (args.mode === "login") {
      return runLogin(playwright, args.timeoutSec, args.phone, {
        autoSms: false,
        modeLabel: "login",
      });
    }
    if (args.mode === "login-sms") {
      return runLogin(playwright, args.timeoutSec, args.phone, {
        autoSms: true,
        smsTimeoutSec: args.smsTimeoutSec,
        smsPollSec: args.smsPollSec,
        smsSinceSec: args.smsSinceSec,
        modeLabel: "login-sms",
      });
    }
    if (args.mode === "login-qr") return runQrLogin(playwright, args.timeoutSec, args.qrFile);
    const probe = await runProbe(playwright);
    if (args.mode === "ensure-login" && probe.ok && !probe.authenticated) {
      return {
        ...probe,
        ok: false,
        mode: "ensure-login",
        profile_dir: PROFILE_DIR,
        authenticated: false,
        needs_login: true,
        action: "npm run xhs:login",
      };
    }
    if (args.mode === "ensure-login") {
      return {
        ...probe,
        mode: "ensure-login",
      };
    }
    return probe;
  });

  console.log(JSON.stringify(result));
  if (!result.ok) {
    process.exitCode = result.needs_login ? 2 : 1;
  }
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exitCode = 1;
});
