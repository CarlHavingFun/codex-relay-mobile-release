#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {
    manifest: path.join(ROOT, "output", "qr_refresh", "qr_manifest.json"),
    output: path.join(ROOT, "output", "qr_refresh", "scan_login_note.html"),
    title: "跨平台扫码登录清单（带二维码）",
    background: "你在外面通过 codexiphone 跟我对话，需要保持电脑端各平台登录态。",
    usage: "在手机里依次识别下图二维码登录，完成后回我“全部扫完”。",
    maxHeight: 460,
    embed: "file-url",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest" && argv[i + 1]) out.manifest = path.resolve(argv[++i]);
    else if (arg === "--output" && argv[i + 1]) out.output = path.resolve(argv[++i]);
    else if (arg === "--title" && argv[i + 1]) out.title = String(argv[++i]);
    else if (arg === "--background" && argv[i + 1]) out.background = String(argv[++i]);
    else if (arg === "--usage" && argv[i + 1]) out.usage = String(argv[++i]);
    else if (arg === "--max-height" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.maxHeight = Math.floor(n);
    } else if (arg === "--embed" && argv[i + 1]) out.embed = String(argv[++i]).trim();
  }
  return out;
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function detectMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function formatTime(input) {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 19).replace("T", " ");
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildImageBlock(filePath, maxHeight) {
  const abs = path.resolve(filePath);
  const encodedPath = abs
    .split(path.sep)
    .map((part, idx) => (idx === 0 && part === "" ? "" : encodeURIComponent(part)))
    .join("/");
  return `<img style="max-width: 100%; max-height: ${maxHeight}px;" src="file://${encodedPath}">`;
}

function buildDataImageBlock(filePath, maxHeight) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString("base64");
  const mime = detectMime(filePath);
  return `<img style="max-width: 100%; max-height: ${maxHeight}px;" src="data:${mime};base64,${b64}">`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(args.manifest, "utf8");
  const manifest = JSON.parse(raw);
  const items = Array.isArray(manifest.items) ? manifest.items : [];

  if (items.length === 0) {
    throw new Error(`manifest has no items: ${args.manifest}`);
  }

  const lines = [];
  lines.push(`<div><h2>${htmlEscape(args.title)}</h2></div>`);
  lines.push(`<div>更新时间：${htmlEscape(formatTime(manifest.generated_at))}</div>`);
  lines.push(`<div>背景：${htmlEscape(args.background)}</div>`);
  lines.push(`<div>用法：${htmlEscape(args.usage)}</div>`);
  lines.push("<div><br></div>");

  let included = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const label = item.label || item.id || `平台${i + 1}`;
    const url = item.url || item.final_url || "";
    const imageFile = item.qr_image || item.full_image;
    if (!imageFile || !fs.existsSync(imageFile)) continue;

    const fallbackHint =
      item.qr_box == null
        ? "<div>（该平台截图为登录页全图，二维码在图中右侧或页面中部）</div>"
        : "";

    lines.push(`<div><b>${i + 1}. ${htmlEscape(label)}</b></div>`);
    if (url) lines.push(`<div>${htmlEscape(url)}</div>`);
    if (fallbackHint) lines.push(fallbackHint);
    const imageHtml =
      args.embed === "data-uri"
        ? buildDataImageBlock(imageFile, args.maxHeight)
        : buildImageBlock(imageFile, args.maxHeight);
    lines.push(`<div>${imageHtml}</div>`);
    lines.push("<div><br></div>");
    included += 1;
  }

  lines.push("<div><b>回执模板：</b></div>");
  lines.push("<div>1) 公众号已扫码，继续</div>");
  lines.push("<div>2) B站已扫码，继续</div>");
  lines.push("<div>3) 全部扫完，开始全平台分发</div>");

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, lines.join(""));

  const result = {
    ok: true,
    manifest: args.manifest,
    output: args.output,
    generated_at: new Date().toISOString(),
    included_items: included,
    total_items: items.length,
    embed: args.embed,
  };
  console.log(JSON.stringify(result));
}

main();
