import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProtonMailBrowserClient, extractFirstOtpCode, matchOpenAiEmail, defaultSessionFile } from "../src/index.js";
import { __internal } from "../src/browser-client.js";

describe("ProtonMailBrowserClient exports", () => {
  it("exports a constructible browser client", () => {
    const client = new ProtonMailBrowserClient({ headless: true });
    assert.ok(client);
    assert.equal(typeof client.loginAndSaveSession, "function");
    assert.equal(typeof client.getInboxMessages, "function");
    assert.equal(typeof client.getLatestMessage, "function");
    assert.equal(typeof client.extractOtpCode, "function");
  });

  it("extracts a 6-digit OTP from text", () => {
    assert.equal(extractFirstOtpCode("Your OpenAI code is 123456."), "123456");
    assert.equal(extractFirstOtpCode("No code here"), "");
  });

  it("matches OpenAI-related previews", () => {
    assert.equal(matchOpenAiEmail("OpenAI verification code"), true);
    assert.equal(matchOpenAiEmail("noreply@openai.com sent a sign in code"), true);
    assert.equal(matchOpenAiEmail("Invoice from another sender"), false);
  });

  it("provides a default session file path", () => {
    assert.ok(defaultSessionFile().endsWith("data/protonmail-auth.json"));
  });

  it("does not classify generic challenge wording as CAPTCHA", () => {
    assert.equal(__internal.hasAuthChallengeText("Challenge yourself with encrypted email"), false);
    assert.equal(__internal.hasAuthChallengeText("A secure login protects your account"), false);
  });

  it("classifies visible human-verification wording as an auth challenge", () => {
    assert.equal(__internal.hasAuthChallengeText("Please verify that you are human"), true);
    assert.equal(__internal.hasAuthChallengeText("Complete this security check"), true);
  });

  it("writes cooldown files with private file mode at creation time", () => {
    const sessionFile = path.join(os.tmpdir(), "protonmail-browser-client-test", "session.json");
    const cooldownFile = path.join(path.dirname(sessionFile), "protonmail-login-cooldown.json");
    const originalMkdirSync = fs.mkdirSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;
    const originalChmodSync = fs.chmodSync;
    const mkdirs = [];
    const writes = [];
    const renames = [];
    const chmods = [];

    fs.mkdirSync = (dirPath, options) => {
      mkdirs.push({ dirPath, options });
    };
    fs.writeFileSync = (filePath, content, options) => {
      writes.push({ filePath, content, options });
    };
    fs.renameSync = (oldPath, newPath) => {
      renames.push({ oldPath, newPath });
    };
    fs.chmodSync = (filePath, mode) => {
      chmods.push({ filePath, mode });
    };

    try {
      __internal.writeCooldown(sessionFile, "CAPTCHA detected");
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
      fs.chmodSync = originalChmodSync;
    }

    assert.deepEqual(mkdirs[0], { dirPath: path.dirname(sessionFile), options: { recursive: true } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath.startsWith(`${cooldownFile}.`), true);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.equal(JSON.parse(writes[0].content).reason, "CAPTCHA detected");
    assert.deepEqual(renames, [{ oldPath: writes[0].filePath, newPath: cooldownFile }]);
    assert.equal(chmods.some((call) => call.filePath === cooldownFile), false);
  });

  it("writes browser storage state with private file mode at creation time", async () => {
    const sessionFile = path.join(os.tmpdir(), "protonmail-browser-client-test", "session.json");
    const storageState = { cookies: [], origins: [] };
    const originalMkdirSync = fs.mkdirSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;
    const originalChmodSync = fs.chmodSync;
    const mkdirs = [];
    const writes = [];
    const renames = [];
    const chmods = [];
    let storageStateOptions;

    fs.mkdirSync = (dirPath, options) => {
      mkdirs.push({ dirPath, options });
    };
    fs.writeFileSync = (filePath, content, options) => {
      writes.push({ filePath, content, options });
    };
    fs.renameSync = (oldPath, newPath) => {
      renames.push({ oldPath, newPath });
    };
    fs.chmodSync = (filePath, mode) => {
      chmods.push({ filePath, mode });
    };

    try {
      await __internal.saveSession({
        storageState: async (options) => {
          storageStateOptions = options;
          return storageState;
        },
      }, sessionFile);
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
      fs.chmodSync = originalChmodSync;
    }

    assert.equal(storageStateOptions, undefined);
    assert.deepEqual(mkdirs[0], { dirPath: path.dirname(sessionFile), options: { recursive: true } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath.startsWith(`${sessionFile}.`), true);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.deepEqual(JSON.parse(writes[0].content), storageState);
    assert.deepEqual(renames, [{ oldPath: writes[0].filePath, newPath: sessionFile }]);
    assert.equal(chmods.some((call) => call.filePath === sessionFile), false);
  });

  it("replaces existing session and cooldown files with private-mode files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-browser-client-test-"));
    const sessionFile = path.join(tempDir, "session.json");
    const cooldownFile = path.join(tempDir, "protonmail-login-cooldown.json");

    try {
      fs.writeFileSync(sessionFile, "{}\n", { encoding: "utf8", mode: 0o644 });
      fs.writeFileSync(cooldownFile, "{}\n", { encoding: "utf8", mode: 0o644 });

      await __internal.saveSession({ storageState: async () => ({ cookies: [], origins: [] }) }, sessionFile);
      __internal.writeCooldown(sessionFile, "CAPTCHA detected");

      assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(cooldownFile).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
