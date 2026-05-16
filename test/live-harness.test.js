import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLivePrefix, makeLivePrefix, redact, shouldRetryWithFreshLogin } from "./live/helpers.js";

describe("live test harness guardrails", () => {
  it("generates unique test-data prefixes", () => {
    const first = makeLivePrefix("guard");
    const second = makeLivePrefix("guard");
    assert.match(first, /^pm-guard-/u);
    assert.match(second, /^pm-guard-/u);
    assert.notEqual(first, second);
  });

  it("refuses to operate on data without the current prefix", () => {
    const prefix = makeLivePrefix("guard");
    assert.doesNotThrow(() => assertLivePrefix(`subject ${prefix}`, prefix));
    assert.throws(() => assertLivePrefix("ordinary inbox message", prefix), /refusing to touch non-test data/u);
  });

  it("redacts email-like values in diagnostics", () => {
    assert.equal(redact("owner@example.com token=abc"), "[email] token=[redacted]");
    assert.equal(redact('{"token":"abc","sessionValid":false}'), '{"token":"[redacted]","sessionValid":false}');
  });

  it("retries stale saved sessions when trusted fresh login is available", () => {
    const env = {
      PROTONMAIL_ALLOW_FRESH_LOGIN: "1",
      PROTONMAIL_USERNAME: "primary@example.com",
      PROTONMAIL_PASSWORD: "secret",
    };
    const result = {
      success: false,
      sessionValid: false,
      error: "Automatic login completed but target mail folder was not reachable",
    };

    assert.equal(shouldRetryWithFreshLogin(result, "/tmp/session.json", {}, env), true);
    assert.equal(shouldRetryWithFreshLogin({ success: true, sessionValid: true }, "/tmp/session.json", {}, env), false);
    assert.equal(shouldRetryWithFreshLogin(result, "", {}, env), false);
    assert.equal(shouldRetryWithFreshLogin(result, "/tmp/session.json", {}, { ...env, PROTONMAIL_ALLOW_FRESH_LOGIN: "0" }), false);
  });
});
