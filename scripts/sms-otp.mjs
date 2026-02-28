#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");

const PLATFORM_RULES = {
  xiaohongshu: ["小红书", "xhs", "RED"],
  wechat_official: ["微信公众平台", "公众号", "微信"],
  video_channel: ["视频号", "微信视频号", "微信"],
  douyin: ["抖音", "douyin", "字节"],
  kuaishou: ["快手", "kuaishou"],
  bilibili: ["哔哩哔哩", "bilibili", "B站"],
  weibo: ["微博", "weibo"],
  zhihu: ["知乎", "zhihu"],
  toutiao: ["今日头条", "头条号", "toutiao"],
  baijiahao: ["百家号", "baijiahao", "百度"],
  penguin: ["企鹅号", "腾讯"],
  sohu: ["搜狐号", "搜狐"],
  wangyi: ["网易号", "网易"],
  douban: ["豆瓣", "douban"],
  jike: ["即刻", "jike"],
};

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    platform: null,
    keywords: [],
    sender: "",
    sinceSec: 900,
    timeoutSec: 0,
    pollSec: 2,
    dbPath: DEFAULT_DB,
    maxRows: 300,
    listPlatforms: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--platform") {
      out.platform = String(args[i + 1] || "").trim().toLowerCase();
      i += 1;
    } else if (arg === "--keyword") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.keywords.push(raw);
      i += 1;
    } else if (arg === "--sender") {
      out.sender = String(args[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--since-sec") {
      const raw = Number(args[i + 1] || 0);
      if (Number.isFinite(raw) && raw >= 0) out.sinceSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--timeout-sec") {
      const raw = Number(args[i + 1] || 0);
      if (Number.isFinite(raw) && raw >= 0) out.timeoutSec = Math.floor(raw);
      i += 1;
    } else if (arg === "--poll-sec") {
      const raw = Number(args[i + 1] || 0);
      if (Number.isFinite(raw) && raw > 0) out.pollSec = Math.max(1, Math.floor(raw));
      i += 1;
    } else if (arg === "--db-path") {
      const raw = String(args[i + 1] || "").trim();
      if (raw) out.dbPath = raw;
      i += 1;
    } else if (arg === "--max-rows") {
      const raw = Number(args[i + 1] || 0);
      if (Number.isFinite(raw) && raw > 0) out.maxRows = Math.max(20, Math.floor(raw));
      i += 1;
    } else if (arg === "--list-platforms" || arg === "--platforms") {
      out.listPlatforms = true;
    }
  }
  return out;
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const v = String(raw || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function normalizeKeywords(platform, extraKeywords) {
  const base = platform && PLATFORM_RULES[platform] ? PLATFORM_RULES[platform] : [];
  return unique([...(base || []), ...(extraKeywords || [])]);
}

function appleDateToUnixMs(raw) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1_000_000_000_000) {
    return n / 1_000_000 + 978_307_200_000;
  }
  return n * 1000 + 978_307_200_000;
}

function extractOtpCode(text) {
  const source = String(text || "");
  const patterns = [
    /(?:验证码|校验码|动态码|verification code|code)[^\d]{0,16}(\d{4,8})/i,
    /(\d{4,8})(?=[^\d]{0,10}(?:验证码|校验码|动态码|verification code|code))/i,
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function textPreview(text, max = 80) {
  const plain = String(text || "").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max)}...`;
}

function runSqliteJson(dbPath, sql) {
  const child = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
  });
  return {
    status: child.status ?? 1,
    stdout: String(child.stdout || ""),
    stderr: String(child.stderr || ""),
  };
}

function readRecentMessages(dbPath, maxRows) {
  const sql = [
    "SELECT",
    "  m.ROWID AS rowid,",
    "  m.date AS raw_date,",
    "  COALESCE(m.text, '') AS text,",
    "  COALESCE(h.id, '') AS sender,",
    "  COALESCE(m.service, '') AS service",
    "FROM message m",
    "LEFT JOIN handle h ON m.handle_id = h.ROWID",
    "WHERE m.is_from_me = 0",
    "  AND COALESCE(m.text, '') <> ''",
    "ORDER BY m.date DESC",
    `LIMIT ${Math.max(20, Math.floor(maxRows))};`,
  ].join(" ");

  const res = runSqliteJson(dbPath, sql);
  if (res.status !== 0) {
    const errText = `${res.stderr}\n${res.stdout}`;
    const denied =
      errText.includes("authorization denied") ||
      errText.includes("not authorized") ||
      errText.includes("Operation not permitted");
    return {
      ok: false,
      accessDenied: denied,
      error: errText.trim() || "sqlite_query_failed",
      messages: [],
    };
  }
  try {
    const parsed = JSON.parse(res.stdout || "[]");
    if (!Array.isArray(parsed)) {
      return { ok: false, accessDenied: false, error: "sqlite_json_not_array", messages: [] };
    }
    return { ok: true, accessDenied: false, error: null, messages: parsed };
  } catch {
    return { ok: false, accessDenied: false, error: "sqlite_json_parse_failed", messages: [] };
  }
}

function matchMessage(msg, { keywords, sender, minUnixMs }) {
  const text = String(msg?.text || "");
  const from = String(msg?.sender || "");
  const unixMs = appleDateToUnixMs(msg?.raw_date);
  if (unixMs < minUnixMs) return false;

  if (sender) {
    if (!from.toLowerCase().includes(sender.toLowerCase())) return false;
  }

  if (keywords && keywords.length) {
    const hay = `${text}\n${from}`.toLowerCase();
    const hit = keywords.some((k) => hay.includes(String(k || "").toLowerCase()));
    if (!hit) return false;
  }
  return true;
}

function findLatestOtp(messages, filter) {
  for (const msg of messages) {
    if (!matchMessage(msg, filter)) continue;
    const code = extractOtpCode(msg.text);
    if (!code) continue;
    const unixMs = appleDateToUnixMs(msg.raw_date);
    return {
      code,
      sender: String(msg.sender || ""),
      service: String(msg.service || ""),
      received_at: new Date(unixMs).toISOString(),
      message_preview: textPreview(msg.text, 120),
    };
  }
  return null;
}

function print(result, exitCode = 0) {
  console.log(JSON.stringify(result));
  if (exitCode) process.exitCode = exitCode;
}

function main() {
  const args = parseArgs();
  if (args.listPlatforms) {
    print({
      ok: true,
      platforms: Object.keys(PLATFORM_RULES).map((name) => ({
        name,
        keywords: PLATFORM_RULES[name],
      })),
    });
    return;
  }

  const keywords = normalizeKeywords(args.platform, args.keywords);
  const started = Date.now();
  const deadline = args.timeoutSec > 0 ? started + args.timeoutSec * 1000 : started;

  while (true) {
    const read = readRecentMessages(args.dbPath, args.maxRows);
    if (!read.ok) {
      if (read.accessDenied) {
        print(
          {
            ok: false,
            error: "messages_db_access_denied",
            db_path: args.dbPath,
            detail: textPreview(read.error, 180),
            action:
              "请在 macOS 设置 -> 隐私与安全性 -> 完全磁盘访问权限 中给终端应用（Terminal/iTerm/Codex）授权后重试。",
          },
          2,
        );
        return;
      }
      print(
        {
          ok: false,
          error: "messages_db_query_failed",
          detail: textPreview(read.error, 200),
        },
        1,
      );
      return;
    }

    const minUnixMs = Date.now() - Math.max(0, args.sinceSec) * 1000;
    const hit = findLatestOtp(read.messages, {
      keywords,
      sender: args.sender,
      minUnixMs,
    });
    if (hit) {
      print({
        ok: true,
        platform: args.platform || null,
        code: hit.code,
        sender: hit.sender,
        service: hit.service,
        received_at: hit.received_at,
        message_preview: hit.message_preview,
        keywords_used: keywords,
      });
      return;
    }

    if (args.timeoutSec <= 0 || Date.now() >= deadline) {
      print(
        {
          ok: false,
          error: "otp_not_found",
          platform: args.platform || null,
          since_sec: args.sinceSec,
          keywords_used: keywords,
          sender_filter: args.sender || null,
        },
        3,
      );
      return;
    }
    sleep(args.pollSec * 1000);
  }
}

main();
