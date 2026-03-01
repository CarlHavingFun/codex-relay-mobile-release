#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const out = {
    envFile: path.join(ROOT, "config", ".env"),
    baseURL: "",
    token: "",
    workspace: "*",
    output: path.join(ROOT, "state", "relay_setup", "relay_setup_qr.png"),
    printSetupURL: false,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env-file") {
      out.envFile = resolvePath(argv[++i] || "");
      continue;
    }
    if (arg === "--base-url") {
      out.baseURL = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "--token") {
      out.token = String(argv[++i] || "").trim();
      continue;
    }
    if (arg === "--workspace") {
      const value = String(argv[++i] || "").trim();
      out.workspace = value || "*";
      continue;
    }
    if (arg === "--out") {
      out.output = resolvePath(argv[++i] || "");
      continue;
    }
    if (arg === "--print-setup-url") {
      out.printSetupURL = true;
      continue;
    }
    if (arg === "--quiet") {
      out.quiet = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown_arg:${arg}`);
  }

  return out;
}

function resolvePath(value) {
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.join(ROOT, value);
}

function loadEnvFile(filePath) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function normalizeBaseURL(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return base;
}

function printHelp() {
  console.log(`Generate a Relay setup QR for iOS auto-fill.

Usage:
  node scripts/relay-setup-qr.mjs [options]

Options:
  --env-file <path>   Read RELAY_BASE_URL/RELAY_TOKEN from env file (default: config/.env)
  --base-url <url>    Override Relay base URL
  --token <token>     Override bearer token
  --workspace <name>  Workspace value for setup link (default: *)
  --out <path>        Output PNG path (default: state/relay_setup/relay_setup_qr.png)
  --print-setup-url   Print full setup URL (sensitive: contains token)
  --quiet             Print only machine-friendly output lines
  -h, --help          Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const fromFile = loadEnvFile(args.envFile);

  const baseURL = normalizeBaseURL(args.baseURL || process.env.RELAY_BASE_URL || fromFile.RELAY_BASE_URL || "");
  const token = String(args.token || process.env.RELAY_TOKEN || fromFile.RELAY_TOKEN || "").trim();
  const workspace = String(args.workspace || "*").trim() || "*";

  if (!baseURL) {
    throw new Error("missing_base_url: set RELAY_BASE_URL in env file or pass --base-url");
  }
  if (!token) {
    throw new Error("missing_token: set RELAY_TOKEN in env file or pass --token");
  }

  const setupURL =
    `codexrelay://setup?base_url=${encodeURIComponent(baseURL)}` +
    `&token=${encodeURIComponent(token)}` +
    `&workspace=${encodeURIComponent(workspace)}`;

  const outputPath = resolvePath(args.output);
  if (!outputPath) throw new Error("missing_output_path");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await QRCode.toFile(outputPath, setupURL, {
    type: "png",
    width: 768,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  if (args.quiet) {
    console.log(`png_path=${outputPath}`);
    console.log(`base_url=${baseURL}`);
    console.log(`workspace=${workspace}`);
    if (args.printSetupURL) {
      console.log(`setup_url=${setupURL}`);
    }
    return;
  }

  console.log("Relay setup QR generated.");
  console.log(`PNG: ${outputPath}`);
  console.log(`Base URL: ${baseURL}`);
  console.log(`Workspace: ${workspace}`);
  if (args.printSetupURL) {
    console.log("Setup URL (sensitive):");
    console.log(setupURL);
  } else {
    console.log("Setup URL hidden by default because it contains a sensitive token.");
    console.log("Use --print-setup-url to output the full URL.");
  }
}

main().catch((err) => {
  console.error(`[relay-setup-qr] ${String(err?.message || err)}`);
  process.exit(1);
});
