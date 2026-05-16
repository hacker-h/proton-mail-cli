#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { decryptFile } from "./session-cache.mjs";

const encryptedCache = getArg("--encrypted-cache") || ".ci-proton/session.enc";
const output = getArg("--output") || process.env.PROTONMAIL_LIVE_SESSION_FILE || ".ci-proton/session.json";
const cacheKey = process.env.PROTONMAIL_SESSION_CACHE_KEY || "";
const sessionJson = process.env.PROTONMAIL_SESSION_JSON || "";
const freshLoginAllowed = process.env.PROTONMAIL_ALLOW_FRESH_LOGIN === "1";

if (fs.existsSync(encryptedCache)) {
  if (!cacheKey) {
    warn("Encrypted session cache exists, but PROTONMAIL_SESSION_CACHE_KEY is missing; falling back.");
  } else {
    try {
      decryptFile(encryptedCache, output, cacheKey);
      console.log(`Prepared live session from encrypted cache at ${encryptedCache}`);
      process.exit(0);
    } catch {
      warn("Encrypted session cache could not be decrypted or parsed; falling back.");
      fs.rmSync(encryptedCache, { force: true });
    }
  }
}

if (sessionJson) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sessionJson, { encoding: "utf8", mode: 0o600 });
  JSON.parse(sessionJson);
  console.log("Prepared live session from PROTONMAIL_SESSION_JSON.");
  process.exit(0);
}

if (freshLoginAllowed) {
  console.log("No reusable live session found; trusted fresh login is allowed.");
  process.exit(0);
}

console.error("Missing usable branch session cache and PROTONMAIL_SESSION_JSON, and this event is not allowed to use Proton credentials.");
process.exit(1);

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function warn(message) {
  console.warn(`Warning: ${message}`);
}
