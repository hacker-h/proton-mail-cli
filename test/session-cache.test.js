import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptFile } from "../scripts/session-cache.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREPARE = path.join(ROOT, "scripts", "prepare-live-session.mjs");
const tempDirs = [];

after(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("live session preparation", () => {
  it("uses a valid encrypted branch cache", () => {
    const directory = tempDir();
    const source = path.join(directory, "source.json");
    const encrypted = path.join(directory, "session.enc");
    const output = path.join(directory, "session.json");
    fs.writeFileSync(source, JSON.stringify(sessionState("cache")));
    encryptFile(source, encrypted, "cache-key");

    const result = runPrepare({ encrypted, output, env: { PROTONMAIL_SESSION_CACHE_KEY: "cache-key" } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), sessionState("cache"));
  });

  it("falls back to seeded session JSON when a restored cache is corrupt", () => {
    const directory = tempDir();
    const encrypted = path.join(directory, "session.enc");
    const output = path.join(directory, "session.json");
    fs.writeFileSync(encrypted, "not-json");

    const result = runPrepare({
      encrypted,
      output,
      env: {
        PROTONMAIL_SESSION_CACHE_KEY: "cache-key",
        PROTONMAIL_SESSION_JSON: JSON.stringify(sessionState("seed")),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Encrypted session cache could not be decrypted/u);
    assert.equal(fs.existsSync(encrypted), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), sessionState("seed"));
  });

  it("does not write malformed seeded session JSON", () => {
    const directory = tempDir();
    const output = path.join(directory, "session.json");
    const result = runPrepare({
      encrypted: path.join(directory, "missing.enc"),
      output,
      env: { PROTONMAIL_SESSION_JSON: "not-json" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PROTONMAIL_SESSION_JSON is not valid JSON/u);
    assert.equal(fs.existsSync(output), false);
  });

  it("falls back to seeded session JSON when a cache exists but the cache key is missing", () => {
    const directory = tempDir();
    const encrypted = path.join(directory, "session.enc");
    const output = path.join(directory, "session.json");
    fs.writeFileSync(encrypted, "encrypted-cache");

    const result = runPrepare({
      encrypted,
      output,
      env: { PROTONMAIL_SESSION_JSON: JSON.stringify(sessionState("seed")) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /PROTONMAIL_SESSION_CACHE_KEY is missing/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), sessionState("seed"));
  });

  it("fails clearly when a cache exists but the cache key is missing and no fallback is available", () => {
    const directory = tempDir();
    const encrypted = path.join(directory, "session.enc");
    const output = path.join(directory, "session.json");
    fs.writeFileSync(encrypted, "encrypted-cache");

    const result = runPrepare({ encrypted, output });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PROTONMAIL_SESSION_CACHE_KEY is missing/u);
    assert.match(result.stderr, /Missing usable branch session cache/u);
    assert.equal(fs.existsSync(encrypted), true);
    assert.equal(fs.existsSync(output), false);
  });

  it("fails clearly when a restored cache is corrupt and no fallback is available", () => {
    const directory = tempDir();
    const encrypted = path.join(directory, "session.enc");
    const output = path.join(directory, "session.json");
    fs.writeFileSync(encrypted, "not-json");

    const result = runPrepare({ encrypted, output, env: { PROTONMAIL_SESSION_CACHE_KEY: "cache-key" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Encrypted session cache could not be decrypted/u);
    assert.match(result.stderr, /Missing usable branch session cache/u);
    assert.equal(fs.existsSync(encrypted), false);
    assert.equal(fs.existsSync(output), false);
  });

  it("allows trusted fresh login when no reusable session exists", () => {
    const directory = tempDir();
    const result = runPrepare({
      encrypted: path.join(directory, "missing.enc"),
      output: path.join(directory, "session.json"),
      env: { PROTONMAIL_ALLOW_FRESH_LOGIN: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fresh login is allowed/u);
  });

  it("fails when no cache, seed, or trusted fresh login is available", () => {
    const directory = tempDir();
    const result = runPrepare({ encrypted: path.join(directory, "missing.enc"), output: path.join(directory, "session.json") });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing usable branch session cache/u);
  });
});

function runPrepare({ encrypted, output, env = {} }) {
  return spawnSync(process.execPath, [PREPARE, "--encrypted-cache", encrypted, "--output", output], {
    cwd: ROOT,
    env: { ...process.env, PROTONMAIL_SESSION_CACHE_KEY: "", PROTONMAIL_SESSION_JSON: "", PROTONMAIL_ALLOW_FRESH_LOGIN: "0", ...env },
    encoding: "utf8",
  });
}

function sessionState(value) {
  return { cookies: [{ name: "pm", value, domain: ".proton.me", path: "/" }], origins: [] };
}

function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-session-cache-"));
  tempDirs.push(directory);
  return directory;
}
