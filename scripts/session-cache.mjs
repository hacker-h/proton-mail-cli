#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}
const command = args[0] || "";

if (!command || args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node scripts/session-cache.mjs <encrypt|decrypt> --input <path> --output <path>

Environment:
  PROTONMAIL_SESSION_CACHE_KEY   Secret encryption key for cached session payloads
`);
  process.exit(command ? 0 : 1);
}

const input = getArg("--input");
const output = getArg("--output");
const secret = process.env.PROTONMAIL_SESSION_CACHE_KEY || "";

if (!input || !output) {
  fail("Missing --input or --output");
}
if (!secret) {
  fail("Missing PROTONMAIL_SESSION_CACHE_KEY");
}
if (Buffer.byteLength(secret, "utf8") < 32) {
  fail("PROTONMAIL_SESSION_CACHE_KEY must contain at least 32 bytes of entropy");
}

if (command === "encrypt") {
  encryptFile(input, output, secret);
} else if (command === "decrypt") {
  decryptFile(input, output, secret);
} else {
  fail(`Unknown command: ${command}`);
}

function encryptFile(inputPath, outputPath, keySecret) {
  const plaintext = fs.readFileSync(inputPath);
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(keySecret).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
}

function decryptFile(inputPath, outputPath, keySecret) {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (payload?.alg !== "aes-256-gcm" || payload?.v !== 1) {
    fail("Unsupported session cache payload");
  }
  const key = crypto.createHash("sha256").update(keySecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]);
  JSON.parse(decrypted.toString("utf8"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, decrypted, { mode: 0o600 });
}

function getArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
