import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, mock } from "node:test";

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

  it("creates cooldown files with private file mode", () => {
    const sessionFile = path.join("/tmp", "protonmail-session", "protonmail-auth.json");
    const cooldownFile = path.join("/tmp", "protonmail-session", "protonmail-login-cooldown.json");
    const originalMkdirSync = fs.mkdirSync;
    const originalChmodSync = fs.chmodSync;
    const originalWriteFileSync = fs.writeFileSync;
    const writes = [];
    const chmods = [];

    fs.mkdirSync = mock.fn();
    fs.chmodSync = mock.fn((target, mode) => chmods.push({ target, mode }));
    fs.writeFileSync = mock.fn((target, content, options) => writes.push({ target, content, options }));

    try {
      __internal.writeCooldown(sessionFile, "CAPTCHA detected during Proton Mail login");
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.chmodSync = originalChmodSync;
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, cooldownFile);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.equal(chmods.some(({ target }) => target === cooldownFile), false);
  });

  it("creates session storage files with private file mode", async () => {
    const sessionFile = path.join("/tmp", "protonmail-session", "protonmail-auth.json");
    const storageState = { cookies: [{ name: "session", value: "secret" }], origins: [] };
    const storageStateCalls = [];
    const context = {
      storageState: async (...args) => {
        storageStateCalls.push(args);
        return storageState;
      },
    };
    const originalMkdirSync = fs.mkdirSync;
    const originalChmodSync = fs.chmodSync;
    const originalWriteFileSync = fs.writeFileSync;
    const writes = [];
    const chmods = [];

    fs.mkdirSync = mock.fn();
    fs.chmodSync = mock.fn((target, mode) => chmods.push({ target, mode }));
    fs.writeFileSync = mock.fn((target, content, options) => writes.push({ target, content, options }));

    try {
      await __internal.saveSession(context, sessionFile);
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.chmodSync = originalChmodSync;
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.deepEqual(storageStateCalls, [[]]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, sessionFile);
    assert.deepEqual(JSON.parse(writes[0].content), storageState);
    assert.equal(writes[0].content.endsWith("\n"), true);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.equal(chmods.some(({ target }) => target === sessionFile), false);
  });
});
