import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

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

  it("emits debug logs only when Proton debug mode is enabled", () => {
    const previousDebug = process.env.PROTONMAIL_DEBUG;
    const warning = mock.method(console, "warn", () => {});

    try {
      assert.equal(__internal.isDebugLoggingEnabled({ PROTONMAIL_DEBUG: "true" }), true);
      delete process.env.PROTONMAIL_DEBUG;
      __internal.debugLog("hidden failure", new Error("hidden"));
      assert.equal(warning.mock.callCount(), 0);

      process.env.PROTONMAIL_DEBUG = "1";
      __internal.debugLog("visible failure", new Error("boom"));
      assert.equal(warning.mock.callCount(), 1);
      assert.match(warning.mock.calls[0].arguments[0], /\[protonmail-debug\] visible failure: boom/u);

      __internal.debugLog("injected env failure", new Error("boom"), { PROTONMAIL_DEBUG: "true" });
      assert.equal(warning.mock.callCount(), 2);
    } finally {
      warning.mock.restore();
      if (previousDebug === undefined) {
        delete process.env.PROTONMAIL_DEBUG;
      } else {
        process.env.PROTONMAIL_DEBUG = previousDebug;
      }
    }
  });
});
