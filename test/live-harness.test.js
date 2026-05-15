import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLivePrefix, makeLivePrefix, redact } from "./live/helpers.js";

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
  });
});
