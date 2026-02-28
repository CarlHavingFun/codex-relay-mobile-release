#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const BRIDGE = path.join(
  CODEX_HOME,
  "skills",
  "apple-notes-task-sync",
  "scripts",
  "notes_bridge.applescript",
);

function parseArgs(argv) {
  const out = {
    manifest: path.join(ROOT, "output", "qr_refresh", "qr_manifest.json"),
    title: "跨平台扫码登录清单（带二维码）",
    folder: "Codex Draft Review",
    maxHeight: 460,
    background: "你在外面通过 codexiphone 跟我对话，需要保持电脑端各平台登录态。",
    usage: "在手机里依次识别下图二维码登录，完成后回我“全部扫完”。",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--manifest" && argv[i + 1]) out.manifest = path.resolve(argv[++i]);
    else if (a === "--title" && argv[i + 1]) out.title = String(argv[++i]);
    else if (a === "--folder" && argv[i + 1]) out.folder = String(argv[++i]);
    else if (a === "--background" && argv[i + 1]) out.background = String(argv[++i]);
    else if (a === "--usage" && argv[i + 1]) out.usage = String(argv[++i]);
    else if (a === "--max-height" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.maxHeight = Math.floor(n);
    }
  }
  return out;
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function runBridge(args) {
  const p = spawnSync("osascript", [BRIDGE, ...args], { encoding: "utf8" });
  if (p.status !== 0) {
    throw new Error(`bridge_failed(${args[0]}): ${p.stderr || p.stdout || `exit ${p.status}`}`);
  }
  return String(p.stdout || "").trim();
}

function formatTime(input) {
  const d = input ? new Date(input) : new Date();
  const x = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

function imageTagFromPath(filePath, maxHeight) {
  const url = pathToFileURL(path.resolve(filePath)).href;
  return `<img style="max-width: 100%; max-height: ${maxHeight}px;" src="${url}">`;
}

function writeById(noteId, title, folder, html, tmpFile) {
  fs.writeFileSync(tmpFile, html);
  runBridge(["write_html_file_by_id", noteId, title, tmpFile, folder]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (items.length === 0) throw new Error(`manifest has no items: ${args.manifest}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-note-"));
  const tmpFile = path.join(workDir, "note.html");

  let html = "";
  html += `<div><h2>${htmlEscape(args.title)}</h2></div>`;
  html += `<div>更新时间：${htmlEscape(formatTime(manifest.generated_at))}</div>`;
  html += `<div>背景：${htmlEscape(args.background)}</div>`;
  html += `<div>用法：${htmlEscape(args.usage)}</div>`;
  html += "<div><br></div>";
  fs.writeFileSync(tmpFile, html);

  runBridge(["write_html_file", args.title, args.folder, tmpFile]);
  const noteId = runBridge(["ensure_note", args.title, args.folder]);

  let included = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const filePath = it.qr_image || it.full_image;
    if (!filePath || !fs.existsSync(filePath)) continue;

    const label = it.label || it.id || `平台${i + 1}`;
    const url = it.url || it.final_url || "";
    html = runBridge(["read_body_by_id", noteId]);
    html += `<div><b>${i + 1}. ${htmlEscape(label)}</b></div>`;
    if (url) html += `<div>${htmlEscape(url)}</div>`;
    if (it.qr_box == null) {
      html += "<div>（该平台截图为登录页全图，二维码在图中右侧或页面中部）</div>";
    }
    html += `<div>${imageTagFromPath(filePath, args.maxHeight)}</div>`;
    html += "<div><br></div>";
    writeById(noteId, args.title, args.folder, html, tmpFile);
    included += 1;
  }

  html = runBridge(["read_body_by_id", noteId]);
  html += "<div><b>回执模板：</b></div>";
  html += "<div>1) 公众号已扫码，继续</div>";
  html += "<div>2) B站已扫码，继续</div>";
  html += "<div>3) 全部扫完，开始全平台分发</div>";
  writeById(noteId, args.title, args.folder, html, tmpFile);

  const finalBody = runBridge(["read_body_by_id", noteId]);
  const nullCount = (finalBody.match(/data:image\/png;base64,\(null\)/g) || []).length;

  const out = {
    ok: nullCount === 0,
    note_id: noteId,
    included_items: included,
    total_items: items.length,
    null_images: nullCount,
    manifest: args.manifest,
    title: args.title,
    folder: args.folder,
  };
  console.log(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}

main();
