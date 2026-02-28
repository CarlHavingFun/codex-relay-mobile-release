#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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
    manifest: "/tmp/qr_refresh_subset.json",
    folder: "Codex Draft Review",
    indexTitle: "今晚扫码清单（仅补扫）",
    prefix: "今晚补扫",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--manifest" && argv[i + 1]) out.manifest = path.resolve(argv[++i]);
    else if (a === "--folder" && argv[i + 1]) out.folder = String(argv[++i]);
    else if (a === "--index-title" && argv[i + 1]) out.indexTitle = String(argv[++i]);
    else if (a === "--prefix" && argv[i + 1]) out.prefix = String(argv[++i]);
  }
  return out;
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function run(cmd, args) {
  const p = spawnSync(cmd, args, { encoding: "utf8" });
  if (p.status !== 0) {
    throw new Error(`${cmd} failed: ${p.stderr || p.stdout || `exit ${p.status}`}`);
  }
  return String(p.stdout || "").trim();
}

function runBridge(args) {
  return run("osascript", [BRIDGE, ...args]);
}

function runOsaInline(script) {
  return run("osascript", ["-e", script]);
}

function formatTime(input) {
  const d = input ? new Date(input) : new Date();
  const x = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

function q(s) {
  return String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ensureSingleAttachment(noteId, imagePath) {
  const script = `
set noteId to "${q(noteId)}"
set imgPath to "${q(imagePath)}"
tell application "Notes"
  set n to first note whose id is noteId
  tell n
    try
      repeat while (count of attachments) > 0
        delete attachment 1
      end repeat
    end try
    make new attachment with data (POSIX file imgPath)
    repeat while (count of attachments) > 1
      delete attachment 2
    end repeat
  end tell
end tell
`;
  runOsaInline(script);
}

function verifyAttachment(noteId, outPng) {
  const script = `
set noteId to "${q(noteId)}"
set outPath to "${q(outPng)}"
tell application "Notes"
  set n to first note whose id is noteId
  if (count of attachments of n) is 0 then error "no_attachment"
  save attachment 1 of n in POSIX file outPath
  return "ok"
end tell
`;
  runOsaInline(script);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (items.length === 0) throw new Error(`manifest has no items: ${args.manifest}`);

  const now = formatTime(manifest.generated_at);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-notes-"));
  const created = [];

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const img = it.qr_image || it.full_image;
    if (!img || !fs.existsSync(img)) continue;

    const idx = String(i + 1).padStart(2, "0");
    const label = it.label || it.id || `平台${idx}`;
    const title = `${args.prefix}-${idx}-${label}`;
    const url = it.url || it.final_url || "";

    let html = "";
    html += `<div><b>${htmlEscape(label)}</b></div>`;
    html += `<div>更新时间：${htmlEscape(now)}</div>`;
    if (url) html += `<div>${htmlEscape(url)}</div>`;
    if (it.qr_box == null) html += "<div>该平台为登录页全图，请在图中定位二维码。</div>";
    html += "<div>扫码成功后回到索引页继续下一条。</div>";
    const htmlFile = path.join(tmpDir, `${idx}.html`);
    fs.writeFileSync(htmlFile, html);

    runBridge(["write_html_file", title, args.folder, htmlFile]);
    const noteId = runBridge(["ensure_note", title, args.folder]);
    ensureSingleAttachment(noteId, path.resolve(img));
    verifyAttachment(noteId, path.join(tmpDir, `${idx}-verify.png`));
    created.push({ id: it.id || "", label, title, noteId, url });
  }

  let index = "";
  index += `<div><h2>${htmlEscape(args.indexTitle)}</h2></div>`;
  index += "<div>你现在到家可直接扫码，本清单仅包含“未登录平台”。</div>";
  index += `<div>更新时间：${htmlEscape(now)}</div>`;
  index += "<div><br></div>";
  created.forEach((x, i) => {
    index += `<div>${i + 1}. <b>${htmlEscape(x.title)}</b></div>`;
    if (x.url) index += `<div>${htmlEscape(x.url)}</div>`;
    index += "<div><br></div>";
  });
  index += "<div>回执：全部扫完</div>";

  const indexFile = path.join(tmpDir, "index.html");
  fs.writeFileSync(indexFile, index);
  runBridge(["write_html_file", args.indexTitle, args.folder, indexFile]);

  console.log(
    JSON.stringify({
      ok: true,
      index_title: args.indexTitle,
      folder: args.folder,
      count: created.length,
      notes: created.map((x) => x.title),
    }),
  );
}

main();
